//! OpenNuXL's output as progress.
//!
//! A search runs OpenNuXL once per input, one after the other (`run.rs`); the tracker follows the runs and
//! turns the lines of each into `{label, file, fraction}` (design §4): `file` is the input of the run, the
//! fraction is over the whole search, each run an equal part of it, split into the run's stages.
//!
//! OpenNuXL prints OpenMS' progress lines on stdout (`ProgressLogger`, CMD log type): `Progress of '<label>':`
//! when a step starts (indented by two spaces per enclosing step), then, at most once a second, `\r` and the
//! percentage (`\r12.34 %               `, no line end), and `\r-- done [took 1.23 s (CPU), 0.98 s (Wall)] -- `
//! when it ends. `run.rs` reads `\r` as a line end, so each update is a line here. Its log lines
//! (`OPENMS_LOG_INFO`, stdout) mark the steps that have no progress of their own. The steps of a run, in the
//! order of OpenNuXL's `main_` (OpenNuXL.cpp of the pinned build), and where each one is in the run's part:
//!
//! | OpenNuXL line (stdout)                                                  | label                                       | position     |
//! | ----------------------------------------------------------------------- | ------------------------------------------- | ------------ |
//! | (the run starts: `run.rs`, [`ProgressTracker::start_run`])              | `Searching <name> (k of n)...`              | 0            |
//! | `Running autotune...` (filters `autotune`, `idfilter`)                  | `Autotune: <name> (k of n)...`              | 0.02         |
//! | `IDFilter excludes <n> spectra.` (always; the autotune is over)         | (none)                                      |              |
//! | `Progress of 'loading mzML':` (before the spectra are prepared)         | `Reading the spectra of <name> (k of n)...` | 0.12         |
//! | `Progress of 'Filtering spectra...'`, `'Calculate Nucleotide Tags...'`, `'Calculate intensity ranks...'`, `'Calculate AA Tags...'`, `'Mapping precursors to scan...'`, `'Indexing spectra...'` | `Preparing the spectra of <name> (k of n)...` | 0.13 to 0.18 |
//! | `Progress of 'Load database from FASTA file...'`                        | `Reading the database (k of n)...`          | 0.19         |
//! | `Progress of 'Generating decoys...'`                                    | `Generating decoys (k of n)...`             | 0.20         |
//! | `Progress of 'Scoring peptide models against spectra...'`, its `%`      | `Scoring <name> (k of n)... this step 45 %` | 0.22 to 0.80 |
//! | `Progress of 'Post-processing PSMs... (spectra filtering)'`, `(localization of cross-links)`, `(annotation)` | `Post-processing <name> (k of n)...` | 0.80, 0.82, 0.86 |
//! | `Calculating peptide and XL q-values.`                                  | `FDR: <name> (k of n)...`                   | 0.90         |
//! | `Running percolator.`                                                   | `Percolator: <name> (k of n)...`            | 0.92         |
//! | `Calculating peptide and XL q-values for percolator results.`           | `FDR: <name> (k of n)...`                   | 0.98         |
//!
//! `<name>` is the user's file name (the shim searches links named `<n>__<name>`; the tracker is given the
//! original names). The scoring of the database is most of a run (the iPRG-sized runs of OpenNuXL's users spend
//! minutes there, seconds in the rest), so it gets most of the bar, with its percentages; the positions of the
//! other steps are estimates of where in a run they sit, not measurements. The autotune is a whole search of
//! the run without cross-links (SimpleSearchEngine, which prints nothing), hence its tenth.
//!
//! The autotune's filter step `spectrumclusterfilter` loads the mzML too (`Progress of 'loading mzML':`, between
//! `Running autotune...` and `IDFilter excludes`): that load is the autotune's, and moves nothing.
//!
//! A line that is not in the table gives no event; the fraction never goes back, so a step that comes again
//! later in a run (OpenNuXL loads the mzML a second time for the post-processing) or a step of a run's stage
//! that is over moves nothing.

/// Where each step is in a run's part of the bar (see the table above).
const AUTOTUNE: f64 = 0.02;
const READING: f64 = 0.12;
const PREPARING_START: f64 = 0.13;
const PREPARING_END: f64 = 0.18;
const DATABASE: f64 = 0.19;
const DECOYS: f64 = 0.20;
const SCORING_START: f64 = 0.22;
const SCORING_END: f64 = 0.80;
const POST_PROCESSING: [f64; 3] = [0.80, 0.82, 0.86];
const FDR: f64 = 0.90;
const PERCOLATOR: f64 = 0.92;
const PERCOLATOR_FDR: f64 = 0.98;

/// The steps of the spectra's preparation (OpenNuXL's labels), in their order.
const PREPARING: [&str; 6] = [
    "Filtering spectra...",
    "Calculate Nucleotide Tags...",
    "Calculate intensity ranks...",
    "Calculate AA Tags...",
    "Mapping precursors to scan...",
    "Indexing spectra...",
];

pub const STARTING: &str = "Starting OpenNuXL...";

/// One step to report.
#[derive(Debug, Clone, PartialEq)]
pub struct ProgressUpdate {
    pub label: String,
    /// The 0-based input of the step; -1 outside the files.
    pub file: i32,
    pub fraction: f64,
}

/// The stage of a run that the last line put it in, for the percentages and the lines that come in more than
/// one stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Stage {
    Starting,
    Autotune,
    Spectra,
    Database,
    Scoring,
    PostProcessing,
    Fdr,
    Percolator,
}

#[derive(Debug)]
pub struct ProgressTracker {
    names: Vec<String>,
    count: usize,
    /// The input whose run is going on, once one started.
    current: Option<usize>,
    stage: Stage,
    fraction: f64,
    label: String,
    file: i32,
    last: Option<(String, i32, f64)>,
    /// The highest percentage of the current run's scoring (a lower one is another step's, or late).
    scored: f64,
    /// The current run's autotune has started and not ended (`IDFilter excludes`): a `loading mzML` is its own.
    autotuning: bool,
}

/// The label of `Progress of '<label>':` (indented by its depth), if the line is one.
fn progress_label(line: &str) -> Option<&str> {
    line.trim_start()
        .strip_prefix("Progress of '")?
        .strip_suffix("':")
}

/// The percentage of a progress update (`12.34 %`, the `\r` before it already a line end), as a fraction.
fn percentage(line: &str) -> Option<f64> {
    let number = line.trim().strip_suffix('%')?.trim_end();
    let value: f64 = number.parse().ok()?;
    value.is_finite().then(|| (value / 100.0).clamp(0.0, 1.0))
}

impl ProgressTracker {
    /// `names`: the user's file names, in input order (for the labels).
    pub fn new(names: Vec<String>) -> ProgressTracker {
        ProgressTracker {
            count: names.len().max(1),
            names,
            current: None,
            stage: Stage::Starting,
            fraction: 0.0,
            label: STARTING.to_string(),
            file: -1,
            last: None,
            scored: 0.0,
            autotuning: false,
        }
    }

    /// The last label reported (the stage a failure happened in).
    pub fn label(&self) -> &str {
        &self.label
    }

    /// The input of the last report: `None` outside the files.
    pub fn file(&self) -> Option<i32> {
        (self.file >= 0).then_some(self.file)
    }

    /// `<what> <name> (k of n)...` for the current run.
    fn label_of(&self, what: &str, with_name: bool) -> String {
        let file = self.current.unwrap_or(0);
        let position = format!("({} of {})", file + 1, self.count);
        let name = self.names.get(file).map(String::as_str).unwrap_or("");
        if with_name && !name.is_empty() {
            format!("{what} {name} {position}...")
        } else {
            format!("{what} {position}...")
        }
    }

    /// Reports `label` at the bar position `at` (never behind the last one).
    fn report_at(&mut self, label: String, file: i32, at: f64) -> Option<ProgressUpdate> {
        self.fraction = self.fraction.max(at.clamp(0.0, 1.0));
        self.label = label.clone();
        self.file = file;
        let key = (label.clone(), file, self.fraction);
        if self
            .last
            .as_ref()
            .is_some_and(|l| l.0 == key.0 && l.1 == key.1 && l.2 >= key.2)
        {
            return None;
        }
        self.last = Some(key);
        Some(ProgressUpdate {
            label,
            file,
            fraction: self.fraction,
        })
    }

    /// The bar position of `position` (0..1) in the current run.
    fn run_at(&self, position: f64) -> f64 {
        let file = self.current.unwrap_or(0);
        (file as f64 + position) / self.count as f64
    }

    /// The current run reaches `stage` at `position` of its part, labelled `label`; a step of a stage that is
    /// over moves nothing.
    fn step(&mut self, stage: Stage, position: f64, label: String) -> Option<ProgressUpdate> {
        let file = self.current? as i32;
        if stage < self.stage {
            return None;
        }
        self.stage = stage;
        let at = self.run_at(position);
        self.report_at(label, file, at)
    }

    /// The run of input `file` (0-based) starts: `Searching <name> (k of n)...` at its start, `file / n` of the
    /// bar (the runs before it are done).
    pub fn start_run(&mut self, file: usize) -> ProgressUpdate {
        self.count = self.count.max(file + 1);
        self.current = Some(file);
        self.stage = Stage::Starting;
        self.scored = 0.0;
        self.autotuning = false;
        let label = self.label_of("Searching", true);
        let at = self.run_at(0.0);
        // (a new label: never a repeat)
        self.last = None;
        self.report_at(label, file as i32, at)
            .expect("the start of a run is reported")
    }

    /// One line of the current run's stdout (its line end, `\n` or `\r`, removed); the progress it marks, if any.
    pub fn feed(&mut self, line: &str) -> Option<ProgressUpdate> {
        self.current?;
        if let Some(label) = progress_label(line) {
            return self.progress_started(label);
        }
        if let Some(fraction) = percentage(line) {
            if self.stage == Stage::Scoring && fraction > self.scored {
                self.scored = fraction;
                let label = format!(
                    "{} this step {} %",
                    self.label_of("Scoring", true),
                    (fraction * 100.0).floor() as u32
                );
                return self.step(
                    Stage::Scoring,
                    SCORING_START + fraction * (SCORING_END - SCORING_START),
                    label,
                );
            }
            return None;
        }
        let line = line.trim();
        if line.starts_with("Running autotune...") {
            self.autotuning = true;
            return self.step(Stage::Autotune, AUTOTUNE, self.label_of("Autotune:", true));
        }
        if line.starts_with("IDFilter excludes") {
            self.autotuning = false;
            return None;
        }
        if line.starts_with("Calculating peptide and XL q-values for percolator results") {
            return self.step(
                Stage::Percolator,
                PERCOLATOR_FDR,
                self.label_of("FDR:", true),
            );
        }
        if line.starts_with("Calculating peptide and XL q-values") {
            return self.step(Stage::Fdr, FDR, self.label_of("FDR:", true));
        }
        if line.starts_with("Running percolator.") {
            return self.step(
                Stage::Percolator,
                PERCOLATOR,
                self.label_of("Percolator:", true),
            );
        }
        None
    }

    /// A step with a progress of its own (`Progress of '<label>':`).
    fn progress_started(&mut self, label: &str) -> Option<ProgressUpdate> {
        if label.starts_with("loading mzML") {
            // the spectra are read before they are prepared, and again for the post-processing (moves nothing);
            // the autotune's spectrumclusterfilter reads them too (its own step)
            if self.stage > Stage::Spectra || self.autotuning {
                return None;
            }
            return self.step(
                Stage::Spectra,
                READING,
                self.label_of("Reading the spectra of", true),
            );
        }
        if let Some(k) = PREPARING.iter().position(|p| label.starts_with(p)) {
            let position = PREPARING_START
                + k as f64 / (PREPARING.len() - 1) as f64 * (PREPARING_END - PREPARING_START);
            return self.step(
                Stage::Spectra,
                position,
                self.label_of("Preparing the spectra of", true),
            );
        }
        if label.starts_with("Load database from FASTA file") {
            return self.step(
                Stage::Database,
                DATABASE,
                self.label_of("Reading the database", false),
            );
        }
        if label.starts_with("Generating decoys") {
            return self.step(
                Stage::Database,
                DECOYS,
                self.label_of("Generating decoys", false),
            );
        }
        if label.starts_with("Scoring peptide models against spectra") {
            let label = format!("{} this step 0 %", self.label_of("Scoring", true));
            return self.step(Stage::Scoring, SCORING_START, label);
        }
        if let Some(rest) = label.strip_prefix("Post-processing PSMs...") {
            let k = if rest.contains("localization") {
                1
            } else if rest.contains("annotation") {
                2
            } else {
                0
            };
            return self.step(
                Stage::PostProcessing,
                POST_PROCESSING[k],
                self.label_of("Post-processing", true),
            );
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Step = (String, i32, f64);

    /// The lines of one run of OpenNuXL as it prints them (`\r` updates as lines of their own), in the order of
    /// its `main_`: autotune (the default filters), the spectra, the database with generated decoys, the
    /// scoring with its percentages, the post-processing, the FDR, and Percolator when `percolator`.
    pub fn run_lines(percolator: bool) -> Vec<String> {
        let mut lines: Vec<String> = [
            "Running autotune...",
            "Filtering ...",
            "Peptide PSMs at 1% FDR: 0",
            "Calculating FDR...",
            "Filtering ...",
            "Peptide PSMs at 1% FDR (no percolator): 24",
            "autotune: too few non-cross-linked peptides found. Will keep parameters as-is.",
            "IDFilter excludes 0 spectra.",
            "Progress of 'loading mzML':",
            "-- done [took 0.05 s (CPU), 0.05 s (Wall)] -- ",
        ]
        .map(String::from)
        .to_vec();
        for step in PREPARING {
            lines.push(format!("Progress of '{step}':"));
            lines.push("-- done [took 0.00 s (CPU), 0.00 s (Wall)] -- ".to_string());
        }
        lines.extend(
            [
                "Progress of 'Load database from FASTA file...':",
                "-- done [took 0.00 s (CPU), 0.00 s (Wall)] -- ",
                "Progress of 'Generating decoys...':",
                "-- done [took 0.00 s (CPU), 0.00 s (Wall)] -- ",
                "Progress of 'Scoring peptide models against spectra...':",
                "0.00 %               ",
                "12.34 %               ",
                "56.78 %               ",
                "99.99 %               ",
                "-- done [took 30.12 s (CPU), 3.10 s (Wall)] -- ",
                "Proteins: 2",
                "Peptides: 15",
                "Progress of 'Post-processing PSMs... (spectra filtering)':",
                "  Progress of 'loading mzML':",
                "  -- done [took 0.04 s (CPU), 0.04 s (Wall)] -- ",
                "-- done [took 0.10 s (CPU), 0.10 s (Wall)] -- ",
                "Progress of 'Post-processing PSMs... (localization of cross-links)':",
                "-- done [took 0.10 s (CPU), 0.10 s (Wall)] -- ",
                "Progress of 'Post-processing PSMs... (annotation)':",
                "-- done [took 0.10 s (CPU), 0.10 s (Wall)] -- ",
                "Calculating peptide and XL q-values.",
                "Writing XL results at xl-FDR: 1",
                "Writing XL results at xl-FDR: 0.01",
                "Writing XL protein results at xl-FDR: 0.01",
                "done.",
            ]
            .map(String::from),
        );
        if percolator {
            lines.extend(
                [
                    "Running percolator.",
                    "done.",
                    "Calculating peptide and XL q-values for percolator results.",
                    "Writing XL results at xl-FDR: 1",
                    "done.",
                ]
                .map(String::from),
            );
        }
        lines.push("OpenNuXL took 4.21 s (wall), 31.02 s (CPU), 0.40 s (system), 30.62 s (user); Peak Memory Usage: 388 MB.".to_string());
        lines
    }

    fn steps(names: &[&str], runs: &[Vec<String>]) -> Vec<Step> {
        let mut tracker = ProgressTracker::new(names.iter().map(|n| n.to_string()).collect());
        let mut steps = Vec::new();
        for (k, lines) in runs.iter().enumerate() {
            let p = tracker.start_run(k);
            steps.push((p.label, p.file, p.fraction));
            for line in lines {
                if let Some(p) = tracker.feed(line) {
                    steps.push((p.label, p.file, p.fraction));
                }
            }
        }
        steps
    }

    /// The labels without repeats in a row.
    fn labels(steps: &[Step]) -> Vec<&str> {
        let mut out: Vec<&str> = steps.iter().map(|s| s.0.as_str()).collect();
        out.dedup();
        out
    }

    fn assert_monotone(steps: &[Step]) {
        for pair in steps.windows(2) {
            assert!(pair[1].2 >= pair[0].2, "the fraction goes back: {pair:?}");
        }
        assert!(steps.iter().all(|s| (0.0..1.0).contains(&s.2)), "{steps:?}");
    }

    #[test]
    fn a_run_goes_through_its_stages_with_the_scorings_percentages() {
        let steps = steps(&["RNA_UV.mzML"], &[run_lines(true)]);
        assert_eq!(
            labels(&steps),
            [
                "Searching RNA_UV.mzML (1 of 1)...",
                "Autotune: RNA_UV.mzML (1 of 1)...",
                "Reading the spectra of RNA_UV.mzML (1 of 1)...",
                "Preparing the spectra of RNA_UV.mzML (1 of 1)...",
                "Reading the database (1 of 1)...",
                "Generating decoys (1 of 1)...",
                "Scoring RNA_UV.mzML (1 of 1)... this step 0 %",
                "Scoring RNA_UV.mzML (1 of 1)... this step 12 %",
                "Scoring RNA_UV.mzML (1 of 1)... this step 56 %",
                "Scoring RNA_UV.mzML (1 of 1)... this step 99 %",
                "Post-processing RNA_UV.mzML (1 of 1)...",
                "FDR: RNA_UV.mzML (1 of 1)...",
                "Percolator: RNA_UV.mzML (1 of 1)...",
                "FDR: RNA_UV.mzML (1 of 1)...",
            ]
        );
        assert!(steps.iter().all(|s| s.1 == 0), "{steps:?}");
        let at = |label: &str| steps.iter().find(|s| s.0 == label).unwrap().2;
        assert!((at("Scoring RNA_UV.mzML (1 of 1)... this step 0 %") - SCORING_START).abs() < 1e-9);
        let half = at("Scoring RNA_UV.mzML (1 of 1)... this step 56 %");
        assert!(
            (half - (SCORING_START + 0.5678 * (SCORING_END - SCORING_START))).abs() < 1e-9,
            "{half}"
        );
        assert!((at("Percolator: RNA_UV.mzML (1 of 1)...") - PERCOLATOR).abs() < 1e-9);
        assert!((steps.last().unwrap().2 - PERCOLATOR_FDR).abs() < 1e-9);
        // the second reading of the spectra (the post-processing's) moves nothing
        assert_eq!(
            steps
                .iter()
                .filter(|s| s.0.starts_with("Reading the spectra"))
                .count(),
            1
        );
        assert_monotone(&steps);
    }

    /// With the filter `spectrumclusterfilter` the autotune loads the mzML itself (OpenNuXL.cpp, `f.setLogType` in
    /// the autotune's block): the bar stays at the autotune until it is over (`IDFilter excludes`), then the main
    /// load reads the spectra.
    #[test]
    fn the_autotunes_own_loading_of_the_spectra_is_part_of_the_autotune() {
        let mut lines = run_lines(false);
        let at = lines
            .iter()
            .position(|l| l.starts_with("Calculating FDR..."))
            .unwrap();
        lines.splice(
            at..at,
            [
                "Progress of 'loading mzML':",
                "50.00 %               ",
                "-- done [took 0.05 s (CPU), 0.05 s (Wall)] -- ",
                "Excluded coelution precursors with high spectral similarity: 3",
            ]
            .map(String::from),
        );
        let tuned = steps(&["RNA_UV.mzML"], &[lines]);
        let autotune = tuned
            .iter()
            .position(|s| s.0.starts_with("Autotune"))
            .unwrap();
        let reading = tuned
            .iter()
            .position(|s| s.0.starts_with("Reading the spectra"))
            .unwrap();
        assert_eq!(reading, autotune + 1, "{tuned:?}");
        assert!((tuned[autotune].2 - AUTOTUNE).abs() < 1e-9);
        assert!((tuned[reading].2 - READING).abs() < 1e-9);
        // a run without the autotune (no filter `autotune`, `idfilter`): its one load reads the spectra
        let plain: Vec<String> = run_lines(false)
            .into_iter()
            .filter(|l| !l.starts_with("Running autotune"))
            .collect();
        let untuned = steps(&["RNA_UV.mzML"], &[plain]);
        assert!(
            untuned
                .iter()
                .any(|s| s.0.starts_with("Reading the spectra")),
            "{untuned:?}"
        );
        assert_monotone(&tuned);
        assert_monotone(&untuned);
    }

    #[test]
    fn each_run_is_an_equal_part_of_the_search() {
        let names = ["a.mzML", "b.mzML", "c.mzML"];
        let steps = steps(
            &names,
            &[run_lines(false), run_lines(true), run_lines(false)],
        );
        for (k, name) in names.iter().enumerate() {
            let start = steps
                .iter()
                .find(|s| s.0 == format!("Searching {name} ({} of 3)...", k + 1))
                .unwrap();
            assert_eq!(start.1, k as i32);
            assert!((start.2 - k as f64 / 3.0).abs() < 1e-9, "{start:?}");
            // every step of the run is in its third of the bar, and names its input
            let own: Vec<&Step> = steps
                .iter()
                .filter(|s| s.0.contains(&format!("({} of 3)", k + 1)))
                .collect();
            assert!(own.iter().all(|s| s.1 == k as i32), "{own:?}");
            assert!(
                own.iter()
                    .all(|s| s.2 >= k as f64 / 3.0 && s.2 < (k + 1) as f64 / 3.0),
                "{own:?}"
            );
        }
        // only the second run was rescored
        let l = labels(&steps);
        assert_eq!(
            l.iter()
                .filter(|l| l.starts_with("Percolator:"))
                .collect::<Vec<_>>(),
            [&"Percolator: b.mzML (2 of 3)..."]
        );
        assert_monotone(&steps);
    }

    #[test]
    fn a_run_without_autotune_or_decoys_skips_those_stages() {
        // filters without autotune and idfilter, a database with decoys of its own (no "Generating decoys")
        let lines: Vec<String> = run_lines(false)
            .into_iter()
            .skip_while(|l| !l.starts_with("IDFilter excludes"))
            .filter(|l| !l.contains("Generating decoys"))
            .collect();
        let steps = steps(&["x.mzML"], &[lines]);
        let l = labels(&steps);
        assert_eq!(l[1], "Reading the spectra of x.mzML (1 of 1)...");
        assert!(!l
            .iter()
            .any(|l| l.starts_with("Autotune") || l.starts_with("Generating")));
        assert_monotone(&steps);
    }

    #[test]
    fn percentages_count_in_the_scoring_only_and_never_go_back() {
        let mut tracker = ProgressTracker::new(vec!["a.mzML".into()]);
        tracker.start_run(0);
        // the percentages of loading the spectra are no scoring
        assert!(tracker.feed("Progress of 'loading mzML':").is_some());
        assert!(tracker.feed("45.00 %   ").is_none());
        tracker.feed("Progress of 'Scoring peptide models against spectra...':");
        let p = tracker.feed("50.00 %               ").unwrap();
        assert_eq!(p.label, "Scoring a.mzML (1 of 1)... this step 50 %");
        // a lower percentage, or the same again: nothing
        assert!(tracker.feed("10.00 %").is_none());
        assert!(tracker.feed("50.00 %").is_none());
        let q = tracker.feed("50.70 %").unwrap();
        assert!(
            q.fraction > p.fraction && q.label == p.label,
            "{q:?} after {p:?}"
        );
        // a step of an earlier stage, after the scoring began: nothing
        assert!(tracker
            .feed("Progress of 'Filtering spectra...':")
            .is_none());
        assert!(tracker.feed("Running autotune...").is_none());
    }

    #[test]
    fn lines_without_a_step_give_no_event() {
        let mut tracker = ProgressTracker::new(vec!["a.mzML".into()]);
        // before a run: nothing at all
        assert!(tracker.feed("Running autotune...").is_none());
        tracker.start_run(0);
        for line in [
            "",
            "-- done [took 0.00 s (CPU), 0.00 s (Wall)] -- ",
            "Progress of 'Something new...':",
            "Proteins: 2",
            "random text",
            "%",
            "abc %",
            "Writing XL results at xl-FDR: 1",
        ] {
            assert!(tracker.feed(line).is_none(), "{line:?}");
        }
        assert_eq!(tracker.label(), "Searching a.mzML (1 of 1)...");
        assert_eq!(tracker.file(), Some(0));
    }

    #[test]
    fn the_labels_parse_as_the_progress_logger_prints_them() {
        assert_eq!(
            progress_label("    Progress of 'loading mzML':"),
            Some("loading mzML")
        );
        assert_eq!(progress_label("Progress of 'x'"), None);
        assert_eq!(percentage("  12.34 %               "), Some(0.1234));
        assert_eq!(percentage("100.00 %"), Some(1.0));
        assert_eq!(percentage("12.34"), None);
        assert_eq!(percentage("nan %"), None);
    }
}
