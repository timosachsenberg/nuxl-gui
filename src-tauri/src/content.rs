//! What an input holds, as far as New search needs to know before a search (`files::inspect`): the spectrum
//! count of an mzML and whether OpenNuXL can read it to its end, the proteins and residues of a FASTA and what
//! in it would fail the search or surprise. Counts and short messages only, never contents: a message names at
//! most one accession of the user's own database.
//!
//! The checks are cheap next to a search, which reads every file in full anyway: an mzML's first MiB and last
//! 64 KiB, a FASTA in one pass.

use std::collections::hash_map::Entry;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{self, Read};
use std::path::Path;

/// The part of an mzML read for its spectrum list; the header before it is usually a few kB.
const MZML_HEAD: usize = 1 << 20;
/// The end of an mzML read for its closing tag (an indexed mzML has its index there, a few kB per thousand
/// spectra, then the checksum and the closing tag).
const MZML_TAIL: usize = 64 << 10;
/// What an mzML holds: its spectra (the `count` of `<spectrumList>`, if the header says), and why OpenNuXL
/// cannot search it (not mzML, cut off, no spectra).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct MzmlFacts {
    pub spectra: Option<u64>,
    pub problem: Option<String>,
}

/// `n` with thousands separators: 65,535.
fn thousands(n: u64) -> String {
    let digits = n.to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn plural(n: u64, one: &str, many: &str) -> String {
    format!("{} {}", thousands(n), if n == 1 { one } else { many })
}

/// The `count` of the first `<spectrumList` tag in `head`.
fn spectrum_count(head: &str) -> Option<u64> {
    let at = head.find("<spectrumList")?;
    let tag = &head[at..];
    let tag = &tag[..tag.find('>').unwrap_or(tag.len())];
    let count = tag.find("count=\"")?;
    let digits: String = tag[count + 7..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// What the first and last bytes of an mzML say (`head`: its first [`MZML_HEAD`] bytes, `tail` its last
/// [`MZML_TAIL`]; `size` of the file).
fn judge_mzml(name: &str, size: u64, head: &[u8], tail: &[u8]) -> MzmlFacts {
    if size == 0 {
        return MzmlFacts {
            spectra: None,
            problem: Some(format!("{name} is empty.")),
        };
    }
    let text = String::from_utf8_lossy(head);
    let start = text.trim_start_matches('\u{feff}').trim_start();
    // XML: a declaration, a comment, or the root element itself
    if !start.starts_with('<') {
        return MzmlFacts {
            spectra: None,
            problem: Some(format!(
                "{name} is not an mzML file: it is not XML. Convert vendor files to mzML first, e.g. with ProteoWizard msconvert."
            )),
        };
    }
    if !text.contains("<mzML") {
        // (a short file has all of itself in the head; a long one has its root element within the first MiB)
        return MzmlFacts {
            spectra: None,
            problem: Some(format!(
                "{name} is not an mzML file: it has no <mzML> element."
            )),
        };
    }
    let spectra = spectrum_count(&text);
    let end = String::from_utf8_lossy(tail);
    let end = end.trim_end_matches(|c: char| c.is_whitespace() || c == '\0');
    if !end.ends_with("</indexedmzML>") && !end.ends_with("</mzML>") {
        return MzmlFacts {
            spectra,
            problem: Some(format!(
                "{name} is incomplete: it ends before its closing </mzML> tag. The file was cut off, e.g. by an interrupted copy or download."
            )),
        };
    }
    if spectra == Some(0) {
        return MzmlFacts {
            spectra,
            problem: Some(format!("{name} has no spectra.")),
        };
    }
    MzmlFacts {
        spectra,
        problem: None,
    }
}

/// The facts of a plain mzML: its head and its tail, nothing in between.
pub fn mzml(path: &Path, name: &str) -> io::Result<MzmlFacts> {
    use io::{Seek, SeekFrom};
    let mut file = fs::File::open(path)?;
    let size = file.metadata()?.len();
    let mut head = Vec::new();
    (&mut file).take(MZML_HEAD as u64).read_to_end(&mut head)?;
    let mut tail = Vec::new();
    if size > MZML_HEAD as u64 {
        file.seek(SeekFrom::Start(size.saturating_sub(MZML_TAIL as u64)))?;
        file.read_to_end(&mut tail)?;
    } else {
        tail = head.clone();
    }
    Ok(judge_mzml(name, size, &head, &tail))
}

/// What a FASTA holds, and what in it would fail the search or its results (`problems`: the search cannot start)
/// or may surprise (`warnings`: entries listed twice).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FastaFacts {
    pub proteins: u64,
    pub residues: u64,
    pub problems: Vec<String>,
    pub warnings: Vec<String>,
}

/// How often something occurs in the entries, and the first entry it occurs in (its accession, and a detail).
#[derive(Default)]
struct Tally {
    count: u64,
    first: Option<(String, String)>,
}

impl Tally {
    fn add(&mut self, accession: &[u8], detail: impl FnOnce() -> String) {
        self.count += 1;
        if self.first.is_none() {
            self.first = Some((shown_accession(accession), detail()));
        }
    }
}

/// An accession as a message names it: at most 60 characters.
fn shown_accession(accession: &[u8]) -> String {
    let text = String::from_utf8_lossy(accession);
    let mut shown: String = text.chars().take(60).collect();
    if text.chars().count() > 60 {
        shown.push('…');
    }
    shown
}

/// The 128-bit hash of an accession or a sequence (two SipHash runs): a map of these finds an accession twice in a
/// large database, and whether its sequence is the same, without keeping the accessions and sequences.
fn accession_hash(accession: &[u8]) -> u128 {
    let half = |seed: u8| {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        seed.hash(&mut h);
        accession.hash(&mut h);
        h.finish() as u128
    };
    (half(0) << 64) | half(1)
}

/// The one pass over a FASTA.
#[derive(Default)]
struct FastaScan {
    proteins: u64,
    residues: u64,
    /// Bytes of the file so far (a byte-order mark is not counted as content; OpenMS reads one).
    bytes: u64,
    /// A byte that no text file has (NUL and other control characters).
    binary: bool,
    /// A sequence line before the first header.
    headless: bool,
    line_start: bool,
    /// On a header line; collecting its accession (the first word after `>`).
    in_header: bool,
    collecting: bool,
    accession: Vec<u8>,
    /// The residues of the entry being read (upper case: OpenMS reads lowercase ones so), and whether it had other
    /// characters.
    length: u64,
    sequence: Vec<u8>,
    invalid_here: Option<u8>,
    /// The hashes of the accessions so far, with the hash of their sequence.
    seen: HashMap<u128, u128>,
    /// An accession again with another sequence (the results could not tell the two apart: a problem), and with
    /// the same (an entry listed twice, e.g. a FASTA or the contaminants added twice: a warning).
    duplicates: Tally,
    repeated: Tally,
    no_accession: u64,
    empty: Tally,
    invalid: Tally,
}

impl FastaScan {
    /// The scan of a file that starts with `start` (at least its first three bytes, or all of a shorter
    /// file): a byte-order mark there is noted, and the bytes after it are content.
    fn starting(start: &[u8]) -> (FastaScan, usize) {
        let bom = start.starts_with(BOM);
        let scan = FastaScan {
            line_start: true,
            ..Default::default()
        };
        (scan, if bom { BOM.len() } else { 0 })
    }

    /// The entry before the next header (or the end) is complete.
    fn end_entry(&mut self) {
        if self.proteins == 0 {
            // (what came before the first header: `headless`)
            self.length = 0;
            self.sequence.clear();
            self.invalid_here = None;
            return;
        }
        let accession = std::mem::take(&mut self.accession);
        if !accession.is_empty() {
            let sequence = accession_hash(&self.sequence);
            match self.seen.entry(accession_hash(&accession)) {
                Entry::Vacant(e) => {
                    e.insert(sequence);
                }
                Entry::Occupied(e) if *e.get() == sequence => {
                    self.repeated.add(&accession, String::new)
                }
                Entry::Occupied(_) => self.duplicates.add(&accession, String::new),
            }
        }
        let length = self.length;
        if length == 0 {
            self.empty.add(&accession, String::new);
        }
        if let Some(c) = self.invalid_here {
            self.invalid.add(&accession, || {
                if c.is_ascii_graphic() {
                    format!("'{}'", c as char)
                } else {
                    format!("byte {c:#04x}")
                }
            });
        }
        self.accession = accession;
        self.accession.clear();
        self.length = 0;
        self.sequence.clear();
        self.invalid_here = None;
    }

    fn end_accession(&mut self) {
        if !self.collecting {
            return;
        }
        self.collecting = false;
        if self.accession.is_empty() {
            self.no_accession += 1;
        }
    }

    /// The next bytes of the file (after a byte-order mark: [`FastaScan::starting`]).
    fn feed(&mut self, bytes: &[u8]) {
        self.bytes += bytes.len() as u64;
        for &b in bytes {
            if b == 0
                || (b < 0x20 && !matches!(b, b'\t' | b'\n' | b'\r' | 0x0b | 0x0c))
                || b == 0x7f
            {
                self.binary = true;
            }
            if b == b'\n' || b == b'\r' {
                if self.in_header {
                    self.end_accession();
                    self.in_header = false;
                }
                self.line_start = true;
                continue;
            }
            if self.line_start && b == b'>' {
                self.end_entry();
                self.proteins += 1;
                self.in_header = true;
                self.collecting = true;
                self.line_start = false;
                continue;
            }
            self.line_start = false;
            if self.in_header {
                if self.collecting {
                    if b == b' ' || b == b'\t' {
                        // (leading blanks before the accession are skipped)
                        if !self.accession.is_empty() {
                            self.end_accession();
                        }
                    } else {
                        self.accession.push(b);
                    }
                }
                continue;
            }
            // a sequence line
            if b.is_ascii_alphabetic() {
                self.residues += 1;
                if self.proteins == 0 {
                    self.headless = true;
                }
                self.length += 1;
                self.sequence.push(b.to_ascii_uppercase());
            } else if matches!(b, b'*' | b'.' | b' ' | b'\t' | 0x0b | 0x0c) {
                // (a stop, and blanks: OpenMS reads them)
            } else {
                if self.proteins == 0 {
                    self.headless = true;
                }
                if self.invalid_here.is_none() {
                    self.invalid_here = Some(b);
                }
            }
        }
    }

    fn finish(mut self, name: &str) -> FastaFacts {
        if self.in_header {
            self.end_accession();
        }
        self.end_entry();
        let mut problems = Vec::new();
        let mut warnings = Vec::new();
        let first = |t: &Tally| t.first.clone().unwrap_or_default();
        if self.bytes == 0 {
            problems.push(format!("{name} is empty."));
        } else if self.binary {
            problems.push(format!(
                "{name} is not a FASTA file: it is not a text file."
            ));
        } else if self.proteins == 0 {
            problems.push(format!(
                "{name} has no protein entries: no line starts with '>'."
            ));
        } else {
            if self.headless {
                problems.push(format!(
                    "{name} does not start with a header line ('>'), so OpenNuXL cannot read its first entry."
                ));
            }
            if self.no_accession > 0 {
                problems.push(format!(
                    "{name} has {} without an accession (a '>' with nothing after it).",
                    plural(self.no_accession, "entry", "entries")
                ));
            }
            if self.empty.count > 0 {
                problems.push(format!(
                    "{name} has {} without a sequence (the first: {}).",
                    plural(self.empty.count, "entry", "entries"),
                    first(&self.empty).0
                ));
            }
            if self.invalid.count > 0 {
                let (accession, character) = first(&self.invalid);
                problems.push(format!(
                    "{name} has characters that are not amino acids in {} (the first: {character} in {accession}).",
                    plural(self.invalid.count, "sequence", "sequences")
                ));
            }
            if self.duplicates.count > 0 {
                problems.push(format!(
                    "{name} has {} more than once with different sequences (the first: {}). The results need every accession once.",
                    plural(self.duplicates.count, "accession", "accessions"),
                    first(&self.duplicates).0
                ));
            }
            if self.repeated.count > 0 {
                warnings.push(format!(
                    "{name} lists {} twice, with the same accession and sequence (the first: {}), e.g. the file was added twice.",
                    plural(self.repeated.count, "entry", "entries"),
                    first(&self.repeated).0
                ));
            }
        }
        FastaFacts {
            proteins: self.proteins,
            residues: self.residues,
            problems,
            warnings,
        }
    }
}

const BOM: &[u8] = b"\xef\xbb\xbf";

/// The facts of the FASTA at `path` (`name` for the messages), read in pieces.
pub fn fasta(path: &Path, name: &str) -> io::Result<FastaFacts> {
    let mut file = fs::File::open(path)?;
    let mut start = Vec::new();
    (&mut file).take(BOM.len() as u64).read_to_end(&mut start)?;
    let (mut scan, skip) = FastaScan::starting(&start);
    scan.feed(&start[skip..]);
    let mut buffer = vec![0u8; 1 << 20];
    loop {
        let read = match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        };
        scan.feed(&buffer[..read]);
    }
    Ok(scan.finish(name))
}

/// The same for FASTA text in memory (the tests).
pub fn fasta_of(bytes: &[u8], name: &str) -> FastaFacts {
    let (mut scan, skip) = FastaScan::starting(bytes);
    // (in two pieces, as a file is read: an accession across the boundary)
    let bytes = &bytes[skip..];
    let half = bytes.len() / 2;
    scan.feed(&bytes[..half]);
    scan.feed(&bytes[half..]);
    scan.finish(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn thousands_separates_groups_of_three() {
        assert_eq!(thousands(0), "0");
        assert_eq!(thousands(999), "999");
        assert_eq!(thousands(65_535), "65,535");
        assert_eq!(thousands(2_000_000), "2,000,000");
    }

    #[test]
    fn a_clean_fasta_has_no_problems() {
        let facts = fasta_of(
            b">sp|P1|A desc\nPEPTIDE\nKR\r\n>sp|P2|B\nAC*\n>P3\nXBZUOJ.\n",
            "db.fasta",
        );
        assert_eq!(facts.proteins, 3);
        assert_eq!(facts.residues, 17);
        assert!(facts.problems.is_empty(), "{:?}", facts.problems);
        assert!(facts.warnings.is_empty(), "{:?}", facts.warnings);
    }

    #[test]
    fn a_fasta_without_entries_is_refused() {
        assert_eq!(fasta_of(b"", "e.fasta").problems, ["e.fasta is empty."]);
        assert!(
            fasta_of(b"hello world\nthis is not a fasta\n", "t.fasta").problems[0]
                .contains("no protein entries")
        );
        assert!(fasta_of(b"\x00\x01\x02>abc\n", "b.fasta").problems[0].contains("not a text file"));
        // a byte-order mark alone is empty too
        assert_eq!(
            fasta_of(b"\xef\xbb\xbf", "e.fasta").problems,
            ["e.fasta is empty."]
        );
    }

    #[test]
    fn entries_that_fail_the_search_are_problems() {
        let facts = fasta_of(
            b">P1\n>P2\nPEPTIDEK\n>\nAAA\n>P3\nPEP-TIDE\n>P2 again\nKK\n",
            "x.fasta",
        );
        let all = facts.problems.join(" ");
        assert!(
            all.contains("1 entry without a sequence (the first: P1)"),
            "{all}"
        );
        assert!(all.contains("1 entry without an accession"), "{all}");
        assert!(all.contains("1 sequence (the first: '-' in P3)"), "{all}");
        assert!(
            all.contains("1 accession more than once with different sequences (the first: P2)"),
            "{all}"
        );
        // the last entry without a sequence: a file cut off after a header
        assert!(
            fasta_of(b">P1\nKK\n>P2 cut off", "t.fasta").problems[0].contains("(the first: P2)")
        );
        // a sequence before the first header
        assert!(fasta_of(b"MKR\n>P1\nKK\n", "h.fasta").problems[0]
            .contains("does not start with a header line"));
    }

    #[test]
    fn a_byte_order_mark_and_lowercase_residues_are_read() {
        // OpenMS reads both (since OpenMS #10713)
        let facts = fasta_of(b"\xef\xbb\xbf>P1\nmkr\n>P2\nKR\n", "w.fasta");
        assert_eq!(facts.proteins, 2);
        assert_eq!(facts.residues, 5);
        assert!(facts.problems.is_empty(), "{:?}", facts.problems);
        assert!(facts.warnings.is_empty(), "{:?}", facts.warnings);
    }

    #[test]
    fn duplicates_are_found_across_the_pieces_of_a_read() {
        // the accession of the second entry is split between the two pieces of fasta_of
        let text = b">ABCDEFGH x\nKK\n>ABCDEFGH y\nKR\n";
        assert_eq!(fasta_of(text, "d.fasta").problems.len(), 1);
        assert!(fasta_of(b">A\nK\n>AB\nK\n", "d.fasta").problems.is_empty());
    }

    #[test]
    fn an_entry_listed_twice_is_a_warning_an_accession_with_another_sequence_a_problem() {
        // the same accession and sequence (a FASTA added twice; lines and case may differ): a warning
        let twice = fasta_of(b">P1 a\nKKR\n>P2\nMK\n>P1 b\nkk\nr\n>P2\nMK\n", "t.fasta");
        assert!(twice.problems.is_empty(), "{:?}", twice.problems);
        assert_eq!(
            twice.warnings,
            ["t.fasta lists 2 entries twice, with the same accession and sequence (the first: P1), e.g. the file was added twice."]
        );
        // another sequence under an accession: a problem
        let other = fasta_of(b">P1\nKKR\n>P1\nKKK\n", "o.fasta");
        assert_eq!(
            other.problems,
            ["o.fasta has 1 accession more than once with different sequences (the first: P1). The results need every accession once."]
        );
        assert!(other.warnings.is_empty());
    }

    const FOOTER: &str = "</run></mzML>\n<indexListOffset>1</indexListOffset></indexedmzML>\n";

    fn judge(text: &str) -> MzmlFacts {
        let bytes = text.as_bytes();
        judge_mzml("r.mzML", bytes.len() as u64, bytes, bytes)
    }

    #[test]
    fn a_complete_mzml_has_its_count_and_no_problem() {
        let facts = judge(&format!(
            "<?xml version=\"1.0\"?>\n<indexedmzML><mzML><run><spectrumList count=\"139\">{FOOTER}"
        ));
        assert_eq!(
            facts,
            MzmlFacts {
                spectra: Some(139),
                problem: None
            }
        );
        // not indexed
        let facts = judge("<mzML><run><spectrumList count=\"2\"></spectrumList></run></mzML>\n\n");
        assert_eq!(facts.problem, None);
    }

    #[test]
    fn what_opennuxl_cannot_search_is_a_problem() {
        assert_eq!(
            judge_mzml("e.mzML", 0, b"", b"").problem.as_deref(),
            Some("e.mzML is empty.")
        );
        assert!(judge("not xml at all")
            .problem
            .unwrap()
            .contains("is not an mzML file: it is not XML"));
        assert!(judge("<html><body/></html>")
            .problem
            .unwrap()
            .contains("has no <mzML> element"));
        // cut off: the count of the header, and the problem
        let facts = judge("<?xml?><mzML><run><spectrumList count=\"139\"><spectrum index=\"0\">");
        assert_eq!(facts.spectra, Some(139));
        assert!(facts.problem.unwrap().contains("is incomplete"));
        assert!(judge(&format!("<mzML><spectrumList count=\"0\"/>{FOOTER}"))
            .problem
            .unwrap()
            .contains("has no spectra"));
    }
}
