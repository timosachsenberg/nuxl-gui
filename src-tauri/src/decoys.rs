//! The decoys of the contaminants the app appends to a database that has decoys of its own.
//!
//! ProSE reuses the decoys of a database that has them (`Search:decoys auto`) and generates none, so the cRAP
//! entries the app appends ([`crate::args::with_contaminants`]) would be targets without decoys. The app adds
//! their decoys itself, as ProSE would make them: the marker and its position as ProSE detects them in the
//! database (`ProSEAlgorithm::resolveDecoyStrategy_`: OpenMS' `DecoyHelper::findDecoyString`, then the literal
//! `Search:decoy_prefix` as prefix or suffix), the sequence as ProSE generates a decoy
//! (`ProSEAlgorithm::buildDecoyAugmentedDB_`: `DecoyGenerator::reversePeptides` with the search's enzyme, the
//! whole protein reversed for `peptide:enzyme_specificity none`, an initial Met kept in place with
//! `peptide:clip_nterm_methionine`). The database's own decoys may have been made otherwise (e.g. reversed
//! whole); for the FDR what counts is that each target has one decoy of its length and composition.

use serde_json::{Map, Value};
use std::collections::BTreeMap;

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

/// What decides the decoys of the appended entries: the request's parameters, with ProSE's defaults.
#[derive(Debug, Clone, PartialEq)]
pub struct DecoyRules {
    /// `Search:decoys`: only `auto` reuses the database's decoys (`generate` and `ignore` remove them).
    pub mode: String,
    /// `Search:decoy_prefix`: the marker ProSE also recognises literally, as prefix or suffix.
    pub decoy_prefix: String,
    pub enzyme: String,
    /// `peptide:enzyme_specificity none`: the whole protein reversed.
    pub unspecific: bool,
    /// `peptide:clip_nterm_methionine`: an initial M stays in place.
    pub keep_initial_met: bool,
}

impl Default for DecoyRules {
    /// ProSE's defaults.
    fn default() -> DecoyRules {
        DecoyRules {
            mode: "auto".to_string(),
            decoy_prefix: "DECOY_".to_string(),
            enzyme: "Trypsin".to_string(),
            unspecific: false,
            keep_initial_met: true,
        }
    }
}

impl DecoyRules {
    /// The rules of a request's parameters (`SearchSettings::parameters`).
    pub fn of(parameters: &Map<String, Value>) -> DecoyRules {
        let text = |name: &str| match parameters.get(name) {
            Some(Value::String(s)) => Some(s.clone()),
            Some(Value::Bool(b)) => Some(b.to_string()),
            _ => None,
        };
        let defaults = DecoyRules::default();
        DecoyRules {
            mode: text("decoys").unwrap_or(defaults.mode),
            decoy_prefix: text("decoy_prefix").unwrap_or(defaults.decoy_prefix),
            enzyme: text("enzyme").unwrap_or(defaults.enzyme),
            unspecific: text("peptide:enzyme_specificity").as_deref() == Some("none"),
            keep_initial_met: text("peptide:clip_nterm_methionine")
                .map_or(defaults.keep_initial_met, |v| v == "true"),
        }
    }
}

/// Where a database's decoys carry their marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Marker {
    Prefix(String),
    Suffix(String),
}

impl Marker {
    /// The accession of the decoy of `accession`.
    pub fn decoy_of(&self, accession: &str) -> String {
        match self {
            Marker::Prefix(m) => format!("{m}{accession}"),
            Marker::Suffix(m) => format!("{accession}{m}"),
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

/// The counts of `DecoyHelper::countDecoys` and of ProSE's literal check, over a database's accessions.
#[derive(Debug, Default)]
pub struct DecoyStatistics {
    proteins: usize,
    prefixes: usize,
    suffixes: usize,
    /// per marker (lower case): its count as prefix, as suffix, and the spelling of its last occurrence
    markers: BTreeMap<String, (usize, usize, String)>,
    literal_prefix: bool,
    literal_suffix: bool,
}

impl DecoyStatistics {
    /// Counts the accession (the FASTA header up to its first white space) of one entry.
    pub fn count(&mut self, accession: &str, decoy_prefix: &str) {
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
        if !decoy_prefix.is_empty() {
            self.literal_prefix |= accession.starts_with(decoy_prefix);
            self.literal_suffix |= accession.ends_with(decoy_prefix);
        }
    }

    /// The marker of the database's decoys as ProSE detects it; None: the database has no decoys.
    pub fn marker(&self, decoy_prefix: &str) -> Option<Marker> {
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
        // ProSE's own check: any accession with Search:decoy_prefix (prefix preferred)
        if self.literal_prefix {
            Some(Marker::Prefix(decoy_prefix.to_string()))
        } else if self.literal_suffix {
            Some(Marker::Suffix(decoy_prefix.to_string()))
        } else {
            None
        }
    }
}

/// A cleavage rule of OpenMS' Enzymes.xml (as `src/lib/results/derive.ts` has them): a site between residues
/// `at - 1` and `at` when the residue before it is one of `before` (and the one before that one of `before2`),
/// the residue after it one of `after`, and that one no P if `not_p`. None: no condition.
struct Rule {
    before2: Option<&'static str>,
    before: Option<&'static str>,
    after: Option<&'static str>,
    not_p: bool,
}

const fn after_(set: &'static str, not_p: bool) -> Rule {
    Rule {
        before2: None,
        before: Some(set),
        after: None,
        not_p,
    }
}

const fn before_(set: &'static str) -> Rule {
    Rule {
        before2: None,
        before: None,
        after: Some(set),
        not_p: false,
    }
}

/// The rule of an enzyme by its OpenMS name; None: no cleavage (or an enzyme this table does not know).
fn rule(enzyme: &str) -> Option<Rule> {
    Some(match enzyme {
        "Trypsin" => after_("KRX", true),
        "Arg-C" => after_("RX", true),
        "Arg-C/P" => after_("RX", false),
        "Asp-N" => before_("DBX"),
        "Asp-N/B" => before_("DX"),
        "Asp-N_ambic" => before_("DBEZX"),
        "Chymotrypsin" => after_("FYWLJX", true),
        "Chymotrypsin/P" => after_("FYWLJX", false),
        "CNBr" | "cyanogen-bromide" => after_("MX", false),
        "Formic_acid" => Rule {
            before2: None,
            before: Some("DBX"),
            after: Some("DBX"),
            not_p: false,
        },
        "Lys-C" => after_("KX", true),
        "Lys-N" => before_("KX"),
        "Lys-C/P" => after_("KX", false),
        "PepsinA" => after_("FLJX", false),
        "TrypChymo" => after_("FYWLJKRX", true),
        "Trypsin/P" => after_("KRX", false),
        "V8-DE" => after_("DBEZX", true),
        "V8-E" => after_("EZX", true),
        "leukocyte elastase" => after_("ALIJVX", true),
        "proline endopeptidase" => Rule {
            before2: Some("HKRX"),
            before: Some("PX"),
            after: None,
            not_p: true,
        },
        "glutamyl endopeptidase" => after_("DBEZX", false),
        "Alpha-lytic protease" => after_("TASVX", false),
        "2-iodobenzoate" => after_("WX", false),
        "iodosobenzoate" => after_("W", false),
        "staphylococcal protease/D" => after_("EZX", false),
        "proline-endopeptidase/HKR" => after_("PX", false),
        "Glu-C+P" => after_("DBEZX", true),
        "PepsinA + P" => after_("FLJX", true),
        "Clostripain/P" => after_("RX", false),
        "elastase-trypsin-chymotrypsin" => after_("ALIJVKRWFYX", true),
        _ => return None,
    })
}

/// The peptides of `protein` without missed cleavages (ProteaseDigestion::digest, full specificity).
fn digest<'a>(protein: &'a [u8], rule: &Rule) -> Vec<&'a [u8]> {
    let is = |set: Option<&str>, residue: u8| set.is_none_or(|s| s.as_bytes().contains(&residue));
    let mut peptides = Vec::new();
    let mut from = 0;
    for at in 1..protein.len() {
        let site = is(rule.before, protein[at - 1])
            && (rule.before2.is_none() || (at >= 2 && is(rule.before2, protein[at - 2])))
            && is(rule.after, protein[at])
            && !(rule.not_p && protein[at] == b'P');
        if site {
            peptides.push(&protein[from..at]);
            from = at;
        }
    }
    peptides.push(&protein[from..]);
    peptides
}

/// DecoyGenerator::reversePeptides: each peptide of the enzyme reversed but its last residue (the cleavage
/// site), the last peptide of the protein reversed whole; the whole protein reversed for 'unspecific
/// cleavage' and for an enzyme without a rule.
fn reverse_peptides(protein: &[u8], enzyme: &str) -> Vec<u8> {
    let rule = match rule(enzyme) {
        Some(rule) if enzyme != "unspecific cleavage" && !protein.is_empty() => rule,
        _ => return protein.iter().rev().copied().collect(),
    };
    let peptides = digest(protein, &rule);
    let mut out = Vec::with_capacity(protein.len());
    for (k, peptide) in peptides.iter().enumerate() {
        if k + 1 < peptides.len() {
            let (body, site) = peptide.split_at(peptide.len() - 1);
            out.extend(body.iter().rev());
            out.extend_from_slice(site);
        } else {
            out.extend(peptide.iter().rev());
        }
    }
    out
}

/// The decoy ProSE generates of the target sequence `target` (without the stop codons at its end).
pub fn decoy_sequence(target: &str, rules: &DecoyRules) -> String {
    let target = target.trim_end_matches('*').as_bytes();
    let keep_met = rules.keep_initial_met && target.len() > 1 && target[0] == b'M';
    let rest = if keep_met { &target[1..] } else { target };
    let mut decoy: Vec<u8> = if keep_met { vec![b'M'] } else { Vec::new() };
    if rules.unspecific {
        decoy.extend(rest.iter().rev());
    } else {
        decoy.extend(reverse_peptides(rest, &rules.enzyme));
    }
    String::from_utf8_lossy(&decoy).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn marker_of(accessions: &[&str], decoy_prefix: &str) -> Option<Marker> {
        let mut stats = DecoyStatistics::default();
        for a in accessions {
            stats.count(a, decoy_prefix);
        }
        stats.marker(decoy_prefix)
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
    fn the_marker_is_detected_as_prose_detects_it() {
        // half decoys with a common marker: that marker, as spelled in the database
        assert_eq!(
            marker_of(&["P1", "P2", "DECOY_P1", "DECOY_P2"], "DECOY_"),
            Some(Marker::Prefix("DECOY_".into()))
        );
        assert_eq!(
            marker_of(&["P1", "P2", "rev_P1", "rev_P2"], "DECOY_"),
            Some(Marker::Prefix("rev_".into()))
        );
        assert_eq!(
            marker_of(&["P1", "P2", "P1_REVERSED", "P2_REVERSED"], "DECOY_"),
            Some(Marker::Suffix("_REVERSED".into()))
        );
        // a target database: none
        assert_eq!(marker_of(&["P1", "P2", "P3"], "DECOY_"), None);
        // too few for DecoyHelper, but the literal decoy_prefix counts (prefix preferred)
        assert_eq!(
            marker_of(&["P1", "P2", "P3", "P4", "P5", "DECOY_P1"], "DECOY_"),
            Some(Marker::Prefix("DECOY_".into()))
        );
        assert_eq!(
            marker_of(&["P1", "P2", "P3", "P1_DECOY_"], "DECOY_"),
            Some(Marker::Suffix("DECOY_".into()))
        );
        // a custom marker DecoyHelper does not know: only through decoy_prefix
        assert_eq!(
            marker_of(&["P1", "P2", "fake-P1", "fake-P2"], "DECOY_"),
            None
        );
        assert_eq!(
            marker_of(&["P1", "P2", "fake-P1", "fake-P2"], "fake-"),
            Some(Marker::Prefix("fake-".into()))
        );
        assert_eq!(
            Marker::Prefix("rev_".into()).decoy_of("CON__X"),
            "rev_CON__X"
        );
        assert_eq!(
            Marker::Suffix("_rev".into()).decoy_of("CON__X"),
            "CON__X_rev"
        );
    }

    #[test]
    fn decoys_are_generated_as_prose_generates_them() {
        let rules = DecoyRules::default();
        // Trypsin: the peptides reversed but their cleavage site, the last one whole; no site before P
        assert_eq!(decoy_sequence("ABCKDEFRPGHK", &rules), "CBAKKHGPRFED");
        // an initial Met stays in place with clip_nterm_methionine, and stop codons at the end go
        assert_eq!(decoy_sequence("MABCKDE*", &rules), "MCBAKED");
        let no_clip = DecoyRules {
            keep_initial_met: false,
            ..DecoyRules::default()
        };
        assert_eq!(decoy_sequence("MABCKDE", &no_clip), "CBAMKED");
        // Trypsin/P cuts before P too; no specificity: the whole protein reversed
        let tp = DecoyRules {
            enzyme: "Trypsin/P".into(),
            keep_initial_met: false,
            ..DecoyRules::default()
        };
        assert_eq!(decoy_sequence("ABKPCD", &tp), "BAKDCP");
        let none = DecoyRules {
            unspecific: true,
            keep_initial_met: false,
            ..DecoyRules::default()
        };
        assert_eq!(decoy_sequence("ABKPCD", &none), "DCPKBA");
        // Asp-N cuts before D (each peptide keeps its last residue in place, as in OpenMS); an enzyme without a
        // rule reverses the whole protein
        let aspn = DecoyRules {
            enzyme: "Asp-N".into(),
            keep_initial_met: false,
            ..DecoyRules::default()
        };
        assert_eq!(decoy_sequence("ABDCEDF", &aspn), "ABCDEFD");
        let unknown = DecoyRules {
            enzyme: "no cleavage".into(),
            keep_initial_met: false,
            ..DecoyRules::default()
        };
        assert_eq!(decoy_sequence("ABC", &unknown), "CBA");
        let unspecific = DecoyRules {
            enzyme: "unspecific cleavage".into(),
            keep_initial_met: false,
            ..DecoyRules::default()
        };
        assert_eq!(decoy_sequence("ABC", &unspecific), "CBA");
    }

    #[test]
    fn the_rules_come_from_the_requests_parameters() {
        assert_eq!(DecoyRules::of(&Map::new()), DecoyRules::default());
        let params = json!({
            "decoys": "generate",
            "decoy_prefix": "rev_",
            "enzyme": "Lys-C",
            "peptide:enzyme_specificity": "none",
            "peptide:clip_nterm_methionine": false,
        });
        let rules = DecoyRules::of(params.as_object().unwrap());
        assert_eq!(
            rules,
            DecoyRules {
                mode: "generate".into(),
                decoy_prefix: "rev_".into(),
                enzyme: "Lys-C".into(),
                unspecific: true,
                keep_initial_met: false,
            }
        );
    }
}
