//! ProSE's log lines as progress.
//!
//! ProSE reports no numeric progress on the command line: its progress logger is silent there, and the
//! tool prints log lines to stdout (line by line, as it goes). The tracker reads those lines and turns
//! the ones that mark a step into `{label, file, fraction}`, the shape of the web app's progress
//! (`progressMapper`, `app/src/lib/engine/core.ts`), with the web app's labels where it has one.
//!
//! The mapping (the lines are from the pinned ProSE; `tests/fixtures/` holds real runs):
//!
//! | ProSE line (stdout)                                     | label                                           | position in the file's share |
//! | ------------------------------------------------------- | ----------------------------------------------- | ---------------------------- |
//! | `[ProSE] [i/n] Searching <path>`                        | `Searching <name> (i of n)...`                  | 0 (starts the file)          |
//! | `Generating peptides...` (first file only)              | `Building the fragment index...`                | 0.05                         |
//! | `Fragment index built!`                                 | `Searching <name> (i of n)...`                  | 0.15                         |
//! | `[ProSE] Calibration: scoring ...`                      | `Running calibration pass...`                   | 0.2                          |
//! | `[PeptDeepRescoring] ...` (first of the file's search)  | `Adding PeptDeep rescoring features...`         | 0.4                          |
//! | `[ProSE] Protein mapping ...`                           | `Mapping peptides to proteins...`               | 0.6                          |
//! | `[ProSE] Rescoring the PSMs with Percolator...`         | `Rescoring with Percolator...`                  | 0.7                          |
//! | `[ProSE] Running detailed modification analysis ...`    | `Analysing modifications...`                    | 0.9                          |
//! | `[ProSE] Closed search mode - per-file modification analysis skipped` | (the file is done)                | 1                            |
//! | `[ProSE] Running aggregate modification analysis ...` (open search, several files) | (the last file is done) | 1                    |
//! | `[ProSE] ===== Search Report =====`                     | `Writing the results...`                        | (see "The bar")              |
//!
//! `<name>` is the user's file name (the shim searches links named `<n>__<name>`; the tracker is given
//! the original names). `file` is the 0-based input of the step, -1 outside the files.
//!
//! # Chunked searches (`database:chunk_size`)
//!
//! With a chunk size ProSE searches chunk-major, for one input as well as for several: it prints no
//! `Searching` line, but (real runs in `tests/fixtures/prose-chunked-*.stdout.txt`)
//!
//! | ProSE line (stdout)                                  | label                                       | file | fraction                          |
//! | ---------------------------------------------------- | ------------------------------------------- | ---- | --------------------------------- |
//! | `[ProSE] Loading <path>`                             | `Reading the spectra...`                    | -1   | 0                                 |
//! | `[ProSE] Chunk-major multi-file: P proteins, N chunks, M files.` | (sets N and M)                  |      |                                   |
//! | `[ProSE] Chunk k/N (…)`                              | `Searching database chunk k of N...`        | -1   | (k-1)/N of the chunks' part       |
//! | `[PeptDeepRescoring] …` (first before a mapping)     | `Adding PeptDeep rescoring features...`     | j    | file j's part of the rest         |
//! | `Mapping n peptides to p proteins.`                  | `Mapping peptides to proteins...`           | j    | (j = the mappings seen before)    |
//! | `[ProSE] Rescoring the PSMs with Percolator...`      | `Rescoring with Percolator...`              | j    |                                   |
//!
//! The rescoring of the files comes after all chunks, file by file, so those steps are attributed to
//! file 0, 1, … by counting the mapping lines; they share the second half of the files' part of the bar. The index lines of the
//! chunks (`Generating peptides...`, `Fragment index built!`) are not reported. Whatever the mode, a line
//! that is not in the tables gives no event, and the fraction never goes back.
//!
//! # The spectrum view (`-qpx_extended`)
//!
//! After the last file's search ProSE prepares the spectrum view of each input, in input order: it reads the
//! input's spectra again, selects PeptDeep's NCE for it if the search did not (PeptDeep rescoring on a copy of
//! its PSMs, which prints `[PeptDeepRescoring]` lines: no rescoring of the search), predicts the spectra of its
//! PSMs and builds its mz view. The lines (real runs in `tests/fixtures/prose-qpx-*.stdout.txt`, of the pinned ProSE in
//! `tests/fixtures/prose-develop-*.stdout.txt`):
//!
//! | ProSE line (stdout)                                                       | position in the file's share |
//! | ------------------------------------------------------------------------- | ---------------------------- |
//! | (the last file's end, or any `-qpx_extended:` line)                       | 0 (file 1 starts)            |
//! | `-qpx_extended: selecting the NCE of <path> with PeptDeep rescoring ...`  | 0.26                         |
//! | `Progress of 'Predicting fragment intensities ...` (of that selection)    | 0.43                         |
//! | `[PeptDeepRescoring] ...` (the selection's end)                           | 0.67                         |
//! | `-qpx_extended: <path>: PeptDeep predictions of N peptide(s) at NCE x (…)`| 0.97                         |
//! | `-qpx_extended: <path>: N spectra of its PSMs, … peaks kept …`            | 1 (the next file starts)     |
//! | `-qpx_extended: <path>: <step>`, step reading/loading, selecting, predicting, writing (the phase lines of the pinned ProSE, OpenMS #10715: `reading spectra`, `selecting NCE`, `predicting N peptides at NCE x (selected` or `from PeptDeep rescoring)`, the peaks-kept line, `writing`) | 0, 0.26, 0.67, 0.97 |
//!
//! The label is `Preparing the spectrum view (file i of n)...` (one input: `Preparing the spectrum view...`),
//! file -1. The input of a line is its link `<n>__<name>` in the path (else the user's name in it); a line of
//! an earlier input than the current one moves nothing. The positions are those of the iPRG2015 run below
//! (per input: reading the spectra again 11 s, selecting the NCE 7 s plus its predictions 10 s, the PSMs'
//! predictions and the mz view 14 s).
//!
//! # The bar
//!
//! The files' search takes [0, 0.35] of the bar (file i of n the part [i/n, (i+1)/n] of it; in a chunked
//! search the chunks the first half of it and the files' rescoring the rest), the spectrum views
//! [0.35, 0.95] (each input an equal part), the pooled protein inference and FDR of several files
//! (`[ProSE] Protein inference on …`, before OpenMS #10707 `[ProSE] Merged protein inference …`:
//! `Pooling the files...`) 0.95, and the search report (`Writing the results...`) 0.97. Measured with the
//! iPRG2015 runs (16 threads, the yeast database with contaminants, AppImage with ONNX Runtime), the part after
//! the files' search is: with the default settings (PeptDeep off, so each input's NCE is selected) 87 % of the
//! run for three inputs (18 s of 144 s searching), 71 % for one input (7 s of 24 s), 73 % with co-isolated
//! precursors (16 s of 59 s); with PeptDeep on 49–51 % (one input 29 s of 56 s, three 71 s of 145 s). A larger
//! database or a semi-specific search lengthens the search only, so the files get 35 %. The positions are
//! estimates of where in a file's work a step sits, not measurements. Whatever the mode, a line that is not in
//! the tables gives no event, the fraction never goes back, and once the spectrum views began no line of the
//! files' search is reported again.

/// Share of the bar for the files' search; the spectrum views take the rest up to `VIEWS_END`.
const SEARCH_SHARE: f64 = 0.35;
/// In a chunked search (`database:chunk_size`), the part of the files' share for the chunks; the files'
/// rescoring takes the rest of it.
const CHUNKS_PART: f64 = 0.5;
/// Where the spectrum views end: the pooled protein inference of several files.
const VIEWS_END: f64 = 0.95;
const REPORT_FRACTION: f64 = 0.97;

/// The positions of the spectrum view's steps in an input's part of the bar (see the table above).
const VIEW_SELECTING: f64 = 0.26;
const VIEW_SELECTION_PREDICTING: f64 = 0.43;
const VIEW_SELECTED: f64 = 0.67;
const VIEW_WRITING: f64 = 0.97;

pub const POOLING: &str = "Pooling the files...";
pub const WRITING: &str = "Writing the results...";
pub const STARTING: &str = "Starting ProSE...";

/// One step to report.
#[derive(Debug, Clone, PartialEq)]
pub struct ProgressUpdate {
    pub label: String,
    /// The 0-based input of the step; -1 outside the files.
    pub file: i32,
    pub fraction: f64,
}

#[derive(Debug)]
pub struct ProgressTracker {
    names: Vec<String>,
    count: usize,
    /// The input being searched (0-based), if any step of a file was seen.
    current: Option<usize>,
    /// Whether the PeptDeep step of the current file was reported.
    peptdeep_seen: bool,
    fraction: f64,
    label: String,
    file: i32,
    last: Option<(String, i32, f64)>,
    /// The chunks of a chunked search (`Chunk-major` line seen).
    chunks: Option<usize>,
    /// Chunked searches: the `Mapping n peptides` lines seen (one per file).
    mapped: usize,
    /// The input whose spectrum view is being prepared, once the files' search is over; `count`: all done.
    view: Option<usize>,
}

fn basename(path: &str) -> &str {
    path.rsplit(['/', '\\']).next().unwrap_or(path)
}

/// `[i/n] Searching <path>` after the `[ProSE] ` tag: (i, n, path).
fn parse_searching(rest: &str) -> Option<(usize, usize, &str)> {
    let rest = rest.strip_prefix('[')?;
    let (position, path) = rest.split_once("] Searching ")?;
    let (i, n) = position.split_once('/')?;
    Some((i.trim().parse().ok()?, n.trim().parse().ok()?, path.trim()))
}

/// `Chunk-major multi-file: P proteins, N chunks, M files.` after the tag: (N, M).
fn parse_chunk_major(rest: &str) -> Option<(usize, usize)> {
    let rest = rest.strip_prefix("Chunk-major multi-file:")?;
    let number_before = |word: &str| -> Option<usize> {
        let head = rest.split(word).next()?;
        head.rsplit(|c: char| !c.is_ascii_digit())
            .find(|t| !t.is_empty())?
            .parse()
            .ok()
    };
    Some((number_before(" chunks")?, number_before(" files")?))
}

/// `Chunk k/N (20 proteins)` after the tag: (k, N).
fn parse_chunk(rest: &str) -> Option<(usize, usize)> {
    let (k, tail) = rest.strip_prefix("Chunk ")?.split_once('/')?;
    let n: String = tail.chars().take_while(char::is_ascii_digit).collect();
    Some((k.trim().parse().ok()?, n.parse().ok()?))
}

/// The position in an input's spectrum view of the step `step` of a `-qpx_extended:` line (lower case), if
/// it names one: the end of the input's view (1), its PeptDeep predictions, or an explicit phase.
fn view_position(step: &str) -> Option<f64> {
    if step.contains("peaks kept") {
        Some(1.0)
    } else if step.contains("predictions of") || step.contains("writ") {
        Some(VIEW_WRITING)
    } else if step.contains("predict") {
        Some(VIEW_SELECTED)
    } else if step.contains("select") {
        Some(VIEW_SELECTING)
    } else if step.contains("read") || step.contains("load") {
        Some(0.0)
    } else {
        None
    }
}

impl ProgressTracker {
    /// `names`: the user's file names, in input order (for the labels).
    pub fn new(names: Vec<String>) -> ProgressTracker {
        ProgressTracker {
            count: names.len().max(1),
            names,
            current: None,
            peptdeep_seen: false,
            fraction: 0.0,
            label: STARTING.to_string(),
            file: -1,
            last: None,
            chunks: None,
            mapped: 0,
            view: None,
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

    fn searching_label(&self, file: usize) -> String {
        let name = self.names.get(file).map(String::as_str).unwrap_or("");
        format!("Searching {name} ({} of {})...", file + 1, self.count)
    }

    fn view_label(&self, file: usize) -> String {
        if self.count > 1 {
            format!(
                "Preparing the spectrum view (file {} of {})...",
                file + 1,
                self.count
            )
        } else {
            "Preparing the spectrum view...".to_string()
        }
    }

    /// Reports `label` at the bar position `at` (never behind the last one).
    fn report_at(&mut self, label: String, file: i32, at: f64) -> Option<ProgressUpdate> {
        self.fraction = self.fraction.max(at.min(1.0));
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

    /// The bar position of `position` (0..1) in the search of file `file`.
    fn search_at(&self, file: usize, position: f64) -> f64 {
        let done = (file as f64 + position) / self.count as f64;
        if self.chunks.is_some() {
            SEARCH_SHARE * (CHUNKS_PART + done * (1.0 - CHUNKS_PART))
        } else {
            done * SEARCH_SHARE
        }
    }

    /// Reports a step of `file` at `position` (0..1) of the file's part of the bar; a file of -1 is at
    /// `position` of the whole bar.
    fn report(&mut self, label: String, file: i32, position: f64) -> Option<ProgressUpdate> {
        let at = if file < 0 {
            position
        } else {
            self.search_at(file as usize, position)
        };
        self.report_at(label, file, at)
    }

    /// A step of file `file` in a chunked search (the rescoring after the chunks).
    fn chunked_step(&mut self, label: &str, file: usize, position: f64) -> Option<ProgressUpdate> {
        self.current = Some(file.min(self.count - 1));
        self.report(label.to_string(), self.current? as i32, position)
    }

    /// A step of the current file at `position`.
    fn step(&mut self, label: &str, position: f64) -> Option<ProgressUpdate> {
        let file = self.current?;
        self.report(label.to_string(), file as i32, position)
    }

    /// The current file is done; after the last one come the spectrum views.
    fn finish_file(&mut self) -> Option<ProgressUpdate> {
        let file = self.current?;
        if file + 1 < self.count {
            // the next file's step follows at once: nothing to say in between
            self.fraction = self.fraction.max(self.search_at(file + 1, 0.0));
            return None;
        }
        self.start_views()
    }

    /// The files' search is over: the spectrum view of the first input begins (once).
    fn start_views(&mut self) -> Option<ProgressUpdate> {
        if self.view.is_some() {
            return None;
        }
        self.current = None;
        self.view_step(0, 0.0)
    }

    /// Step `position` of the spectrum view of input `file` (never an earlier input than the current one);
    /// at 1 the next input's view begins, after the last one the pooling (several inputs) or the writing.
    fn view_step(&mut self, file: usize, position: f64) -> Option<ProgressUpdate> {
        let mut file = file.min(self.count - 1);
        let mut position = position;
        if let Some(current) = self.view {
            if file < current {
                return None;
            }
        }
        if position >= 1.0 {
            file += 1;
            position = 0.0;
        }
        self.view = Some(file);
        if file >= self.count {
            let label = if self.count > 1 { POOLING } else { WRITING };
            return self.report_at(label.to_string(), -1, VIEWS_END);
        }
        let at = SEARCH_SHARE
            + (file as f64 + position) / self.count as f64 * (VIEWS_END - SEARCH_SHARE);
        self.report_at(self.view_label(file), -1, at)
    }

    /// The input a `-qpx_extended:` line is of, and where its link name ends in `rest`: the shim's link
    /// `<n>__<name>` in the path (the last one, if several match), else the user's name.
    fn input_of(&self, rest: &str) -> Option<(usize, usize)> {
        let mut found: Option<(usize, usize)> = None;
        for k in 0..self.count {
            let needle = format!("{}__", k + 1);
            for (at, _) in rest.match_indices(&needle) {
                let before = rest[..at].chars().next_back();
                if !matches!(before, None | Some('/' | '\\' | ' ')) {
                    continue;
                }
                if found.is_none_or(|(_, end)| at + needle.len() > end) {
                    found = Some((k, at + needle.len()));
                }
            }
        }
        found.or_else(|| {
            self.names
                .iter()
                .enumerate()
                .filter(|(_, name)| !name.is_empty())
                .find_map(|(k, name)| rest.rfind(name.as_str()).map(|at| (k, at + name.len())))
        })
    }

    /// A `-qpx_extended:` line (`rest` after the tag): the spectrum views have begun; its input's step.
    fn feed_view_line(&mut self, rest: &str) -> Option<ProgressUpdate> {
        let started = self.start_views();
        let Some((file, end)) = self.input_of(rest) else {
            return started;
        };
        // the step: after `<path>: `, else before the path (`selecting the NCE of <path> with ...`)
        let step = match rest[end..].find(": ") {
            Some(colon) => &rest[end + colon + 2..],
            None => &rest[..rest.find(['/', '\\']).unwrap_or(rest.len())],
        };
        let step = step.to_lowercase();
        let current = self.view.unwrap_or(0);
        let position = match view_position(&step) {
            Some(position) => position,
            // a line of a later input: its view has begun
            None if file > current => 0.0,
            None => return started,
        };
        self.view_step(file, position).or(started)
    }

    /// The lines while the spectrum views are prepared. `Some(update)` when the line is handled here.
    fn feed_views(&mut self, line: &str) -> Option<Option<ProgressUpdate>> {
        let current = self.view?;
        if current >= self.count {
            return None;
        }
        // PeptDeep rescoring on a copy of the input's PSMs selects its NCE: no rescoring of the search
        if line.starts_with("[PeptDeepRescoring]") {
            return Some(self.view_step(current, VIEW_SELECTED));
        }
        if line.starts_with("Progress of 'Selecting collision energy") {
            return Some(self.view_step(current, VIEW_SELECTING));
        }
        if line.starts_with("Progress of 'Predicting fragment intensities") {
            return Some(self.view_step(current, VIEW_SELECTION_PREDICTING));
        }
        None
    }

    /// The lines of a chunked search. `Some(update)` when the line is handled here (the update may be
    /// `None`: a line that gives no event but must not reach the file-by-file rules), `None` otherwise.
    fn feed_chunked(&mut self, line: &str) -> Option<Option<ProgressUpdate>> {
        let chunks = self.chunks?;
        if self.view.is_some() {
            // the search of the files is over: its lines are not reported again
            return None;
        }
        if line.starts_with("Generating peptides...") || line.starts_with("Fragment index built!") {
            return Some(None);
        }
        if line.starts_with("[PeptDeepRescoring]") {
            if self.peptdeep_seen {
                return Some(None);
            }
            self.peptdeep_seen = true;
            return Some(self.chunked_step(
                "Adding PeptDeep rescoring features...",
                self.mapped,
                0.4,
            ));
        }
        if line.starts_with("Mapping ") && line.contains(" peptides to ") {
            let file = self.mapped;
            self.mapped += 1;
            self.peptdeep_seen = false;
            return Some(self.chunked_step("Mapping peptides to proteins...", file, 0.6));
        }
        let rest = line.strip_prefix("[ProSE] ")?;
        if let Some((k, n)) = parse_chunk(rest) {
            let share = (k.saturating_sub(1)) as f64 / n.max(chunks).max(1) as f64
                * CHUNKS_PART
                * SEARCH_SHARE;
            return Some(self.report_at(
                format!("Searching database chunk {k} of {n}..."),
                -1,
                share,
            ));
        }
        if rest.starts_with("Rescoring the PSMs with Percolator") {
            return Some(self.chunked_step(
                "Rescoring with Percolator...",
                self.mapped.saturating_sub(1),
                0.7,
            ));
        }
        // the other lines (the pooling, the report, the modification analysis) are the file-by-file rules'
        None
    }

    /// Reads one line of ProSE's stdout; returns the progress it marks, if any.
    pub fn feed(&mut self, line: &str) -> Option<ProgressUpdate> {
        let line = line.trim_end();
        if let Some(rest) = line.strip_prefix("-qpx_extended:") {
            return self.feed_view_line(rest.trim_start());
        }
        if let Some(update) = self.feed_views(line) {
            return update;
        }
        if self.chunks.is_some() {
            if let Some(update) = self.feed_chunked(line) {
                return update;
            }
        }
        let viewing = self.view.is_some();
        if !viewing && line.starts_with("Generating peptides...") {
            return self.step("Building the fragment index...", 0.05);
        }
        if !viewing && line.starts_with("Fragment index built!") {
            let label = self.searching_label(self.current?);
            return self.step(&label, 0.15);
        }
        if !viewing && line.starts_with("[PeptDeepRescoring]") {
            if self.peptdeep_seen {
                return None;
            }
            self.peptdeep_seen = true;
            return self.step("Adding PeptDeep rescoring features...", 0.4);
        }
        let rest = line.strip_prefix("[ProSE] ")?;
        // the pooled protein inference with its protein FDR (with several files only the pooled set has one)
        if (rest.starts_with("Protein inference on")
            || rest.starts_with("Merged protein inference"))
            && self.count > 1
        {
            self.current = None;
            self.view = Some(self.count);
            return self.report_at(POOLING.to_string(), -1, VIEWS_END);
        }
        if rest.contains("Search Report") && rest.starts_with('=') {
            // open searches have no end marker of the file: the report is the first thing after the last one
            if self.current.is_some() {
                self.finish_file();
            }
            self.view = Some(self.count);
            return self.report(WRITING.to_string(), -1, REPORT_FRACTION);
        }
        if viewing {
            // the search of the files is over: its lines are not reported again
            return None;
        }
        if rest.starts_with("Loading ") {
            return self.report_at("Reading the spectra...".to_string(), -1, 0.0);
        }
        if let Some((chunks, files)) = parse_chunk_major(rest) {
            self.chunks = Some(chunks);
            self.count = self.count.max(files);
            self.current = None;
            return None;
        }
        if let Some((i, n, path)) = parse_searching(rest) {
            let index = i.saturating_sub(1);
            if n > self.count {
                self.count = n;
            }
            self.current = Some(index);
            self.peptdeep_seen = false;
            let label = if self.names.get(index).is_some() {
                self.searching_label(index)
            } else {
                format!("Searching {} ({i} of {n})...", basename(path))
            };
            return self.report(label, index as i32, 0.0);
        }
        if rest.starts_with("Calibration: scoring") {
            return self.step("Running calibration pass...", 0.2);
        }
        if rest.starts_with("Protein mapping") {
            return self.step("Mapping peptides to proteins...", 0.6);
        }
        if rest.starts_with("Rescoring the PSMs with Percolator") {
            return self.step("Rescoring with Percolator...", 0.7);
        }
        if rest.starts_with("Running detailed modification analysis") {
            return self.step("Analysing modifications...", 0.9);
        }
        if rest.starts_with("Closed search mode - per-file modification analysis skipped")
            || rest.starts_with("Running aggregate modification analysis")
        {
            return self.finish_file();
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type Step = (String, i32, f64);

    fn steps(lines: &str, names: &[&str]) -> Vec<Step> {
        let mut tracker = ProgressTracker::new(names.iter().map(|n| n.to_string()).collect());
        lines
            .lines()
            .filter_map(|line| tracker.feed(line))
            .map(|p| (p.label, p.file, p.fraction))
            .collect()
    }

    const THREE: [&str; 3] = [
        "JD_06232014_sample1_A.mzML",
        "JD_06232014_sample1_B.mzML",
        "JD_06232014_sample1_C.mzML",
    ];

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
        assert!(
            steps.iter().all(|s| (0.0..=1.0).contains(&s.2)),
            "{steps:?}"
        );
    }

    /// The steps from the first spectrum view on.
    fn views(steps: &[Step]) -> &[Step] {
        let first = steps
            .iter()
            .position(|s| s.0.starts_with("Preparing the spectrum view"))
            .expect("a spectrum view");
        &steps[first..]
    }

    #[test]
    fn the_spectrum_views_of_three_files_take_most_of_the_bar() {
        // real output of the pinned ProSE (the AppImage's, with ONNX Runtime): iPRG2015, three inputs, Percolator
        // on, PeptDeep off, so -qpx_extended selects each input's NCE with PeptDeep rescoring on a copy of its PSMs
        let steps = steps(
            include_str!("../tests/fixtures/prose-qpx-three-files.stdout.txt"),
            &THREE,
        );
        let l = labels(&steps);
        assert_eq!(
            l[l.len() - 5..],
            [
                "Preparing the spectrum view (file 1 of 3)...",
                "Preparing the spectrum view (file 2 of 3)...",
                "Preparing the spectrum view (file 3 of 3)...",
                "Pooling the files...",
                "Writing the results...",
            ]
        );
        // the NCE selection's [PeptDeepRescoring] lines are no rescoring of the search
        assert!(
            !l.contains(&"Adding PeptDeep rescoring features..."),
            "{l:?}"
        );
        let v = views(&steps);
        assert!(
            (v[0].2 - SEARCH_SHARE).abs() < 1e-9,
            "the files' search ends at its share: {:?}",
            v[0]
        );
        assert!(v.iter().all(|s| s.1 == -1), "{v:?}");
        // each input's view has its steps (start, NCE selection and its predictions, the selection's end, the PSMs'
        // predictions) inside its third of [0.35, 0.95]
        let second = v.iter().find(|s| s.0.contains("(file 2 of 3)")).unwrap();
        assert!(
            (second.2 - (SEARCH_SHARE + (VIEWS_END - SEARCH_SHARE) / 3.0)).abs() < 1e-9,
            "{second:?}"
        );
        let first_view: Vec<f64> = v
            .iter()
            .filter(|s| s.0.contains("(file 1 of 3)"))
            .map(|s| s.2)
            .collect();
        assert_eq!(first_view.len(), 5, "{first_view:?}");
        let pooling = steps.iter().find(|s| s.0 == POOLING).unwrap();
        assert!((pooling.2 - VIEWS_END).abs() < 1e-9);
        assert!((steps.last().unwrap().2 - REPORT_FRACTION).abs() < 1e-9);
        assert_monotone(&steps);
    }

    #[test]
    fn peptdeep_rescoring_is_reported_in_the_search_only() {
        // real output: one input, PeptDeep on (its NCE is known, so the spectrum view predicts without selecting)
        let steps = steps(
            include_str!("../tests/fixtures/prose-qpx-one-file-peptdeep.stdout.txt"),
            &THREE[..1],
        );
        assert_eq!(
            labels(&steps),
            [
                "Searching JD_06232014_sample1_A.mzML (1 of 1)...",
                "Building the fragment index...",
                "Searching JD_06232014_sample1_A.mzML (1 of 1)...",
                "Adding PeptDeep rescoring features...",
                "Mapping peptides to proteins...",
                "Rescoring with Percolator...",
                "Preparing the spectrum view...",
                "Writing the results...",
            ]
        );
        // the end of the file's search goes on with the spectrum view, not to 95 %
        let at = steps
            .iter()
            .position(|s| s.0 == "Preparing the spectrum view...")
            .unwrap();
        assert!((steps[at].2 - SEARCH_SHARE).abs() < 1e-9, "{:?}", steps[at]);
        assert!(steps[at - 1].2 < SEARCH_SHARE);
        assert_monotone(&steps);
    }

    #[test]
    fn the_phase_lines_of_the_pinned_prose_move_each_spectrum_view() {
        // real output of the pinned ProSE (bundled, with ONNX Runtime): the app's example as two inputs, Percolator on,
        // PeptDeep off, so -qpx_extended reads each input's spectra, selects its NCE, predicts and writes, saying so in
        // `-qpx_extended: <file>: <step>` lines (the peaks-kept line comes before "writing")
        let steps = steps(
            include_str!("../tests/fixtures/prose-develop-two-files-nce.stdout.txt"),
            &["Ecoli_1.mzML", "Ecoli_2.mzML"],
        );
        let l = labels(&steps);
        assert_eq!(l[l.len() - 2..], [POOLING, WRITING]);
        let v = views(&steps);
        let half = (VIEWS_END - SEARCH_SHARE) / 2.0;
        for (k, start) in [(1, SEARCH_SHARE), (2, SEARCH_SHARE + half)] {
            let at: Vec<f64> = v
                .iter()
                .filter(|s| s.0 == format!("Preparing the spectrum view (file {k} of 2)..."))
                .map(|s| s.2)
                .collect();
            // reading, selecting the NCE, predicting at it (the peaks-kept line ends the view, "writing" comes late)
            let expected = [0.0, VIEW_SELECTING, VIEW_SELECTED].map(|p| start + p * half);
            assert_eq!(at.len(), expected.len(), "file {k}: {at:?}");
            for (a, e) in at.iter().zip(expected) {
                assert!(
                    (a - e).abs() < 1e-9,
                    "file {k}: {at:?}, expected {expected:?}"
                );
            }
        }
        assert!(v.iter().all(|s| s.1 == -1), "{v:?}");
        assert!((steps.last().unwrap().2 - REPORT_FRACTION).abs() < 1e-9);
        assert_monotone(&steps);

        // one input with PeptDeep: the view predicts at the rescoring's NCE, without selecting one
        let steps = steps_of_one_peptdeep();
        assert_eq!(
            labels(&steps),
            [
                "Searching Ecoli_1.mzML (1 of 1)...",
                "Building the fragment index...",
                "Searching Ecoli_1.mzML (1 of 1)...",
                "Adding PeptDeep rescoring features...",
                "Mapping peptides to proteins...",
                "Rescoring with Percolator...",
                "Preparing the spectrum view...",
                "Writing the results...",
            ]
        );
        let view: Vec<f64> = steps
            .iter()
            .filter(|s| s.0 == "Preparing the spectrum view...")
            .map(|s| s.2)
            .collect();
        let whole = VIEWS_END - SEARCH_SHARE;
        assert!((view[0] - SEARCH_SHARE).abs() < 1e-9, "{view:?}");
        assert!(
            (view[1] - (SEARCH_SHARE + VIEW_SELECTED * whole)).abs() < 1e-9,
            "{view:?}"
        );
        assert_monotone(&steps);
    }

    fn steps_of_one_peptdeep() -> Vec<Step> {
        steps(
            include_str!("../tests/fixtures/prose-develop-one-file-peptdeep.stdout.txt"),
            &["Ecoli_1.mzML"],
        )
    }

    #[test]
    fn a_chunked_search_never_goes_back_to_a_file_after_its_search() {
        // real output: three inputs, chunks, open search, PeptDeep off; the views' [PeptDeepRescoring] lines came
        // after the last file and were reported as file 3's "Adding PeptDeep rescoring features..."
        let steps = steps(
            include_str!("../tests/fixtures/prose-qpx-chunked-open-three-files.stdout.txt"),
            &["a.mzML", "a.mzML", "valid.mzML.gz"],
        );
        let l = labels(&steps);
        assert!(
            !l.contains(&"Adding PeptDeep rescoring features..."),
            "{l:?}"
        );
        assert_eq!(l[l.len() - 2..], [POOLING, WRITING]);
        let v = views(&steps);
        assert!(
            v.iter().all(|s| s.1 == -1),
            "no file's search after its view began: {v:?}"
        );
        // the chunks take the first half of the files' share, in 9 steps
        let chunk9 = steps
            .iter()
            .find(|s| s.0 == "Searching database chunk 9 of 9...")
            .unwrap();
        assert!(
            (chunk9.2 - 8.0 / 9.0 * CHUNKS_PART * SEARCH_SHARE).abs() < 1e-9,
            "{chunk9:?}"
        );
        // the inputs' links of one name (1__a.mzML, 2__a.mzML) are told apart
        for k in 1..=3 {
            assert!(
                l.contains(&format!("Preparing the spectrum view (file {k} of 3)...").as_str()),
                "{l:?}"
            );
        }
        assert_monotone(&steps);
    }

    #[test]
    fn a_single_open_search_without_an_end_marker_starts_its_view_on_the_qpx_line() {
        // the pinned ProSE's lines of one open input, PeptDeep off: no line ends the file's search, the views'
        // NCE selection follows its modification analysis
        let lines = "[ProSE] [1/1] Searching /s/1-0.partial/1__a.mzML
Fragment index built!
[ProSE] Rescoring the PSMs with Percolator...
[ProSE] Running detailed modification analysis for /s/1-0.partial/1__a.mzML
-qpx_extended: selecting the NCE of /s/1-0.partial/1__a.mzML with PeptDeep rescoring on a copy of its PSMs
Progress of 'Selecting collision energy...':
[PeptDeepRescoring] run 'ProSE_2026-10-24 11:01:03': NCE 29 selected from a grid centred on 35 (median cosine 0.82)
[PeptDeepRescoring] Predicted features added: 69 / 69 PSMs (ms2_cosine, ms2_spectral_angle), NCE=29
-qpx_extended: /s/1-0.partial/1__a.mzML: PeptDeep predictions of 56 peptide(s) at NCE 29 (selected)
-qpx_extended: /s/1-0.partial/1__a.mzML: 69 spectra of its PSMs, 19796 of 19796 peaks kept
[ProSE] ===================== Search Report =====================";
        let steps = steps(lines, &["a.mzML"]);
        assert_eq!(
            labels(&steps),
            [
                "Searching a.mzML (1 of 1)...",
                "Rescoring with Percolator...",
                "Analysing modifications...",
                "Preparing the spectrum view...",
                "Writing the results...",
            ]
        );
        let v = views(&steps);
        let at = |p: f64| SEARCH_SHARE + p * (VIEWS_END - SEARCH_SHARE);
        let fractions: Vec<f64> = v.iter().map(|s| s.2).collect();
        let expected = [
            at(VIEW_SELECTING),
            at(VIEW_SELECTED),
            at(VIEW_WRITING),
            VIEWS_END,
            REPORT_FRACTION,
        ];
        assert_eq!(fractions.len(), expected.len(), "{v:?}");
        for (f, e) in fractions.iter().zip(expected) {
            assert!((f - e).abs() < 1e-9, "{v:?}");
        }
        assert_monotone(&steps);
    }

    #[test]
    fn explicit_phase_lines_move_the_view_of_their_input() {
        // the phase lines of a later ProSE, `-qpx_extended: <file>: <step>`, worded loosely; Windows paths too
        let lines = r"[ProSE] Closed search mode - per-file modification analysis skipped
-qpx_extended: C:\Users\Ana\AppData\Roaming\org.openms.prose.desktop\searches\5-1.partial\1__a b.mzML: reading the spectra
-qpx_extended: C:\Users\Ana\AppData\Roaming\org.openms.prose.desktop\searches\5-1.partial\1__a b.mzML: Selecting the NCE
-qpx_extended: C:\Users\Ana\AppData\Roaming\org.openms.prose.desktop\searches\5-1.partial\1__a b.mzML: predicting the spectra of 120 PSMs at the selected NCE 27
-qpx_extended: C:\Users\Ana\AppData\Roaming\org.openms.prose.desktop\searches\5-1.partial\1__a b.mzML: writing the psm and mz views
-qpx_extended: C:\Users\Ana\AppData\Roaming\org.openms.prose.desktop\searches\5-1.partial\2__c.mzML: Loading spectra
-qpx_extended: C:\Users\Ana\AppData\Roaming\org.openms.prose.desktop\searches\5-1.partial\1__a b.mzML: writing (late line of an earlier input)
-qpx_extended: C:\Users\Ana\AppData\Roaming\org.openms.prose.desktop\searches\5-1.partial\2__c.mzML: writing";
        let mut tracker = ProgressTracker::new(vec!["a b.mzML".into(), "c.mzML".into()]);
        // the last file's search: file 2 of 2
        tracker.feed("[ProSE] [2/2] Searching C:\\x\\2__c.mzML");
        let steps: Vec<Step> = lines
            .lines()
            .filter_map(|line| tracker.feed(line))
            .map(|p| (p.label, p.file, p.fraction))
            .collect();
        let half = (VIEWS_END - SEARCH_SHARE) / 2.0;
        let at = |file: f64, p: f64| SEARCH_SHARE + (file + p) * half;
        let expected = [
            ("Preparing the spectrum view (file 1 of 2)...", at(0.0, 0.0)),
            (
                "Preparing the spectrum view (file 1 of 2)...",
                at(0.0, VIEW_SELECTING),
            ),
            (
                "Preparing the spectrum view (file 1 of 2)...",
                at(0.0, VIEW_SELECTED),
            ),
            (
                "Preparing the spectrum view (file 1 of 2)...",
                at(0.0, VIEW_WRITING),
            ),
            ("Preparing the spectrum view (file 2 of 2)...", at(1.0, 0.0)),
            (
                "Preparing the spectrum view (file 2 of 2)...",
                at(1.0, VIEW_WRITING),
            ),
        ];
        assert_eq!(steps.len(), expected.len(), "{steps:?}");
        for (s, (label, fraction)) in steps.iter().zip(expected) {
            assert_eq!(s.0, label);
            assert!((s.2 - fraction).abs() < 1e-9, "{steps:?}");
        }
    }

    #[test]
    fn the_input_of_a_line_is_its_link_not_a_prefix_of_another() {
        let names: Vec<String> = (1..=12).map(|k| format!("run{k}.mzML")).collect();
        let tracker = ProgressTracker::new(names);
        let input = |line: &str| tracker.input_of(line).map(|(k, _)| k);
        assert_eq!(
            input("/d/s/7-0.partial/11__run11.mzML: 3 spectra of its PSMs"),
            Some(10)
        );
        assert_eq!(
            input("/d/s/7-0.partial/1__run1.mzML: 3 spectra of its PSMs"),
            Some(0)
        );
        // a folder that looks like a link does not count: the last link of the path does
        assert_eq!(
            input("/d/2__x/7-0.partial/12__run12.mzML: reading"),
            Some(11)
        );
        // no link: the user's name
        assert_eq!(
            input("selecting the NCE of /elsewhere/run5.mzML with PeptDeep"),
            Some(4)
        );
        assert_eq!(
            input("this OpenMS was built without ONNX Runtime, so PeptDeep cannot predict"),
            None
        );
    }

    #[test]
    fn a_qpx_line_without_an_input_starts_the_views() {
        let mut tracker = ProgressTracker::new(vec!["a.mzML".into(), "b.mzML".into()]);
        tracker.feed("[ProSE] [1/2] Searching /s/1__a.mzML");
        let p = tracker
            .feed("-qpx_extended: this OpenMS was built without ONNX Runtime, so PeptDeep cannot predict; the spectra are written")
            .unwrap();
        assert_eq!(p.label, "Preparing the spectrum view (file 1 of 2)...");
        assert!((p.fraction - SEARCH_SHARE).abs() < 1e-9);
        // the files' search lines are not reported again
        assert!(tracker
            .feed("[ProSE] [2/2] Searching /s/2__b.mzML")
            .is_none());
        assert!(tracker
            .feed("[ProSE] Rescoring the PSMs with Percolator...")
            .is_none());
        assert!(tracker
            .feed("[PeptDeepRescoring] Predicted features added: 1 / 1 PSMs")
            .is_some_and(|p| p.label.starts_with("Preparing")));
    }
}
