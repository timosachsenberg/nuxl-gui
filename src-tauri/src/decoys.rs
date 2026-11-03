//! The decoys a database brings along, which the app leaves out of the database it gives OpenNuXL.
//!
//! OpenNuXL estimates its FDR only with the decoys it generates itself (`NuXL:decoys true`, its default:
//! `DECOY_` and the target's accession, each tryptic peptide shuffled). With `NuXL:decoys false` it takes the
//! database as it is but then writes no FDR-filtered outputs at all (OpenNuXL.cpp, `main_`: the q-values, the
//! filtered cross-links and peptides and the Percolator rescoring are all inside `if (generate_decoys)`), so
//! the app always lets it generate them. A database that has decoys of its own would then get decoys of its
//! decoys, and its own would count as targets: the shim writes the database without them (`database.fasta`,
//! [`crate::args::write_database`]). The decoys are found as OpenMS finds them (`DecoyHelper::findDecoyString`:
//! a known marker as prefix or suffix of most accessions), or by OpenNuXL's own prefix `DECOY_`.

use std::collections::BTreeMap;

/// OpenNuXL's prefix of the decoys it generates.
pub const DECOY_PREFIX: &str = "DECOY_";

/// The decoy markers OpenMS looks for (`DecoyHelper::affixes`), in its order.
const AFFIXES: &[&str] = &[
    "decoy",
    "dec",
    "reverse",
    "rev",
    "reversed",
    "__id_decoy",
    "xxx",
    "shuffled",
    "shuffle",
    "pseudo",
    "random",
];

/// Where a database's decoys carry their marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Marker {
    Prefix(String),
    Suffix(String),
}

impl Marker {
    /// Whether `accession` is a decoy of this marker (compared ignoring ASCII case, as OpenMS' patterns
    /// match).
    pub fn marks(&self, accession: &str) -> bool {
        let (a, m) = (accession.as_bytes(), self.text().as_bytes());
        if a.len() < m.len() {
            return false;
        }
        let part = match self {
            Marker::Prefix(_) => &a[..m.len()],
            Marker::Suffix(_) => &a[a.len() - m.len()..],
        };
        part.eq_ignore_ascii_case(m)
    }

    /// The marker as the database spells it.
    pub fn text(&self) -> &str {
        match self {
            Marker::Prefix(m) | Marker::Suffix(m) => m,
        }
    }

    /// For a message: "the prefix rev_", "the suffix _REVERSED".
    pub fn describe(&self) -> String {
        match self {
            Marker::Prefix(m) => format!("the prefix {m}"),
            Marker::Suffix(m) => format!("the suffix {m}"),
        }
    }
}

/// The marker of OpenMS' prefix pattern at the start of `lower` (`^(decoy_*|dec_*|...|random_*)`: the first
/// affix that starts it, with the underscores after it).
fn prefix_match(lower: &str) -> Option<&str> {
    let affix = AFFIXES.iter().find(|a| lower.starts_with(**a))?;
    let underscores = lower[affix.len()..]
        .bytes()
        .take_while(|&b| b == b'_')
        .count();
    Some(&lower[..affix.len() + underscores])
}

/// The marker of OpenMS' suffix pattern at the end of `lower` (`(_decoy*|_dec*|...|_random)$`: each affix but
/// the last with its last letter repeated any number of times, also none; the leftmost start that matches).
fn suffix_match(lower: &str) -> Option<&str> {
    let bytes = lower.as_bytes();
    for start in 0..bytes.len() {
        if bytes[start] != b'_' {
            continue;
        }
        let rest = &lower[start + 1..];
        for (k, affix) in AFFIXES.iter().enumerate() {
            let found = if k + 1 == AFFIXES.len() {
                rest == *affix
            } else {
                let (stem, last) = affix.split_at(affix.len() - 1);
                rest.strip_prefix(stem)
                    .is_some_and(|tail| tail.bytes().all(|b| b == last.as_bytes()[0]))
            };
            if found {
                return Some(&lower[start..]);
            }
        }
    }
    None
}

/// The counts of `DecoyHelper::countDecoys` over a database's accessions, and whether any has OpenNuXL's
/// [`DECOY_PREFIX`].
#[derive(Debug, Default)]
pub struct DecoyStatistics {
    proteins: usize,
    prefixes: usize,
    suffixes: usize,
    /// per marker (lower case): its count as prefix, as suffix, and the spelling of its last occurrence
    markers: BTreeMap<String, (usize, usize, String)>,
    own_prefix: bool,
}

impl DecoyStatistics {
    /// Counts the accession (the FASTA header up to its first white space) of one entry.
    pub fn count(&mut self, accession: &str) {
        self.proteins += 1;
        let lower = accession.to_ascii_lowercase();
        if let Some(m) = prefix_match(&lower) {
            self.prefixes += 1;
            let spelling = accession[..m.len()].to_string();
            let entry = self.markers.entry(m.to_string()).or_default();
            entry.0 += 1;
            entry.2 = spelling;
        }
        if let Some(m) = suffix_match(&lower) {
            self.suffixes += 1;
            let spelling = accession[accession.len() - m.len()..].to_string();
            let entry = self.markers.entry(m.to_string()).or_default();
            entry.1 += 1;
            entry.2 = spelling;
        }
        self.own_prefix |= accession.starts_with(DECOY_PREFIX);
    }

    /// The marker of the database's decoys; None: the database has no decoys.
    pub fn marker(&self) -> Option<Marker> {
        let proteins = self.proteins as f64;
        let (prefixes, suffixes) = (self.prefixes as f64, self.suffixes as f64);
        // DecoyHelper::findDecoyString: a marker of at least 80 % of the prefixes (suffixes) and 40 % of the proteins
        if prefixes + suffixes >= 0.4 * proteins && self.prefixes != self.suffixes {
            for (count, _, spelling) in self.markers.values() {
                let n = *count as f64;
                if n / prefixes >= 0.8 && n / proteins >= 0.4 {
                    return Some(Marker::Prefix(spelling.clone()));
                }
            }
            for (_, count, spelling) in self.markers.values() {
                let n = *count as f64;
                if n / suffixes >= 0.8 && n / proteins >= 0.4 {
                    return Some(Marker::Suffix(spelling.clone()));
                }
            }
        }
        // a few of OpenNuXL's own decoys (e.g. the database of an earlier search that kept them): its prefix
        self.own_prefix
            .then(|| Marker::Prefix(DECOY_PREFIX.to_string()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn marker_of(accessions: &[&str]) -> Option<Marker> {
        let mut stats = DecoyStatistics::default();
        for a in accessions {
            stats.count(a);
        }
        stats.marker()
    }

    #[test]
    fn the_patterns_match_as_openms_regular_expressions_do() {
        assert_eq!(prefix_match("decoy_sp|p1"), Some("decoy_"));
        assert_eq!(prefix_match("rev__x"), Some("rev__"));
        // the first affix that matches wins: 'reverse' before 'reversed'
        assert_eq!(prefix_match("reversed_x"), Some("reverse"));
        assert_eq!(prefix_match("sp|p1"), None);
        assert_eq!(suffix_match("sp|p1_rev"), Some("_rev"));
        assert_eq!(suffix_match("p1_decoyyy"), Some("_decoyyy"));
        assert_eq!(
            suffix_match("p1_deco"),
            Some("_deco"),
            "the last letter any number of times, also none"
        );
        assert_eq!(
            suffix_match("p1_randomm"),
            None,
            "the last affix has no repetition"
        );
        assert_eq!(suffix_match("p1_random"), Some("_random"));
        assert_eq!(suffix_match("a_b_rev"), Some("_rev"));
        assert_eq!(suffix_match("p1"), None);
    }

    #[test]
    fn the_marker_is_detected_as_openms_detects_it() {
        // half decoys with a common marker: that marker, as spelled in the database
        assert_eq!(
            marker_of(&["P1", "P2", "DECOY_P1", "DECOY_P2"]),
            Some(Marker::Prefix("DECOY_".into()))
        );
        assert_eq!(
            marker_of(&["P1", "P2", "rev_P1", "rev_P2"]),
            Some(Marker::Prefix("rev_".into()))
        );
        assert_eq!(
            marker_of(&["P1", "P2", "P1_REVERSED", "P2_REVERSED"]),
            Some(Marker::Suffix("_REVERSED".into()))
        );
        // a target database: none
        assert_eq!(marker_of(&["P1", "P2", "P3"]), None);
        // too few for DecoyHelper, but OpenNuXL's own prefix counts
        assert_eq!(
            marker_of(&["P1", "P2", "P3", "P4", "P5", "DECOY_P1"]),
            Some(Marker::Prefix("DECOY_".into()))
        );
        // a marker DecoyHelper does not know: none
        assert_eq!(marker_of(&["P1", "P2", "fake-P1", "fake-P2"]), None);
    }

    #[test]
    fn a_marker_marks_its_decoys_ignoring_case() {
        let rev = Marker::Prefix("rev_".into());
        assert!(rev.marks("rev_P1") && rev.marks("REV_P1"));
        assert!(!rev.marks("P1") && !rev.marks("re"));
        let suffix = Marker::Suffix("_REVERSED".into());
        assert!(suffix.marks("P1_reversed") && !suffix.marks("REVERSED"));
        assert_eq!(suffix.describe(), "the suffix _REVERSED");
        assert_eq!(rev.text(), "rev_");
    }
}
