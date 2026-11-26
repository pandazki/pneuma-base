//! The contract suite: `STORAGE.md` (contract version 1) checked sentence by sentence against any
//! storage provider, an executable given by path. Every check drives only that executable; every
//! check is keyed to the sentences it decides. A check is met when it returns `Ok`, not exercised
//! when it returns `NotExercised` (this machine or this provider cannot show the property), and
//! unmet when it panics: an `assert!` that fails is a sentence the provider does not meet.

mod checks;
pub mod harness;
mod registry;
pub mod sentences;

use std::cell::RefCell;
use std::panic::{self, AssertUnwindSafe};
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

pub use harness::Env;
pub use registry::CHECKS;
use sentences::{SENTENCES, Sentence};

/// Why a check could not show its property here.
#[derive(Debug)]
pub struct NotExercised(pub String);

pub type Outcome = Result<(), NotExercised>;

pub fn not_exercised(why: impl Into<String>) -> Outcome {
    Err(NotExercised(why.into()))
}

pub struct Check {
    pub name: &'static str,
    /// The ids of the sentences this check decides.
    pub sentences: &'static [&'static str],
    /// Run alone, after the parallel checks: the property depends on timing that load disturbs.
    pub serial: bool,
    pub run: fn(&Env) -> Outcome,
}

#[derive(Clone, Debug)]
pub enum Verdict {
    Met,
    Unmet(String),
    NotExercised(String),
}

pub struct Ran {
    pub check: &'static Check,
    pub verdict: Verdict,
    pub took: Duration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    Met,
    Unmet,
    NotExercised,
    NotCheckable,
}

impl Status {
    pub fn label(self) -> &'static str {
        match self {
            Status::Met => "met",
            Status::Unmet => "unmet",
            Status::NotExercised => "not exercised",
            Status::NotCheckable => "not checkable from outside",
        }
    }
}

pub struct Report {
    pub ran: Vec<Ran>,
    pub took: Duration,
    /// Whether a filter left some checks out.
    pub filtered: bool,
}

thread_local! {
    /// Where the last panic on this thread happened, for the failure detail.
    static PANIC_AT: RefCell<Option<String>> = const { RefCell::new(None) };
}

fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(text) = payload.downcast_ref::<String>() {
        text.clone()
    } else if let Some(text) = payload.downcast_ref::<&str>() {
        (*text).to_owned()
    } else {
        "panicked".to_owned()
    }
}

fn run_one(check: &'static Check, env: &Env) -> Ran {
    let started = Instant::now();
    PANIC_AT.with(|at| at.borrow_mut().take());
    let verdict = match panic::catch_unwind(AssertUnwindSafe(|| (check.run)(env))) {
        Ok(Ok(())) => Verdict::Met,
        Ok(Err(NotExercised(why))) => Verdict::NotExercised(why),
        Err(payload) => {
            let mut detail = panic_text(payload.as_ref());
            if let Some(at) = PANIC_AT.with(|at| at.borrow_mut().take()) {
                detail.push_str(&format!(" (at {at})"));
            }
            Verdict::Unmet(detail)
        }
    };
    Ran {
        check,
        verdict,
        took: started.elapsed(),
    }
}

fn selected(check: &Check, filter: Option<&str>) -> bool {
    match filter {
        None => true,
        Some(text) => check.name.contains(text) || check.sentences.iter().any(|s| s.contains(text)),
    }
}

/// Runs every check (those matching `filter`, if given) against the provider at `provider`:
/// independent checks in parallel, then the timing-sensitive ones one at a time.
pub fn run(provider: &Path, filter: Option<&str>) -> Report {
    let started = Instant::now();
    let previous = panic::take_hook();
    panic::set_hook(Box::new(|info| {
        let at = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()));
        PANIC_AT.with(|slot| *slot.borrow_mut() = at);
    }));
    let env = Env::new(provider);
    let chosen: Vec<&'static Check> = CHECKS.iter().filter(|c| selected(c, filter)).collect();
    let results: Mutex<Vec<Option<Ran>>> = Mutex::new((0..chosen.len()).map(|_| None).collect());
    let next = AtomicUsize::new(0);
    let parallel: Vec<usize> = (0..chosen.len()).filter(|&i| !chosen[i].serial).collect();
    let workers = std::thread::available_parallelism().map_or(4, |n| n.get().clamp(2, 8));
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let k = next.fetch_add(1, Ordering::SeqCst);
                    let Some(&i) = parallel.get(k) else { return };
                    let ran = run_one(chosen[i], &env);
                    results.lock().unwrap_or_else(|e| e.into_inner())[i] = Some(ran);
                }
            });
        }
    });
    for (i, check) in chosen.iter().enumerate().filter(|(_, c)| c.serial) {
        let ran = run_one(check, &env);
        results.lock().unwrap_or_else(|e| e.into_inner())[i] = Some(ran);
    }
    panic::set_hook(previous);
    let ran = results
        .into_inner()
        .unwrap_or_else(|e| e.into_inner())
        .into_iter()
        .flatten()
        .collect();
    Report {
        ran,
        took: started.elapsed(),
        filtered: filter.is_some(),
    }
}

impl Report {
    pub fn unmet(&self) -> usize {
        self.ran
            .iter()
            .filter(|r| matches!(r.verdict, Verdict::Unmet(_)))
            .count()
    }

    /// A sentence's status from the checks that decide it, and the detail behind it. `None` when
    /// a filter left all its checks out.
    pub fn status(&self, sentence: &Sentence) -> Option<(Status, String)> {
        if let Some(why) = sentence.not_checkable {
            return (!self.filtered).then(|| (Status::NotCheckable, why.to_owned()));
        }
        let mine: Vec<&Ran> = self
            .ran
            .iter()
            .filter(|r| r.check.sentences.contains(&sentence.id))
            .collect();
        if mine.is_empty() {
            return None;
        }
        let details = |pick: fn(&Verdict) -> Option<&String>| -> String {
            mine.iter()
                .filter_map(|r| pick(&r.verdict).map(|d| format!("{}: {d}", r.check.name)))
                .collect::<Vec<_>>()
                .join("; ")
        };
        let unmet = details(|v| match v {
            Verdict::Unmet(d) => Some(d),
            _ => None,
        });
        if !unmet.is_empty() {
            return Some((Status::Unmet, unmet));
        }
        let skipped = details(|v| match v {
            Verdict::NotExercised(d) => Some(d),
            _ => None,
        });
        if mine.iter().any(|r| matches!(r.verdict, Verdict::Met)) {
            let names: Vec<&str> = mine
                .iter()
                .filter(|r| matches!(r.verdict, Verdict::Met))
                .map(|r| r.check.name)
                .collect();
            let mut detail = format!("by {}", names.join(", "));
            if !skipped.is_empty() {
                detail.push_str(&format!("; not exercised: {skipped}"));
            }
            return Some((Status::Met, detail));
        }
        Some((Status::NotExercised, skipped))
    }

    /// One line per check, in the registry's order.
    pub fn lines(&self) -> String {
        let mut out = String::new();
        for ran in &self.ran {
            let (label, detail) = match &ran.verdict {
                Verdict::Met => ("met", String::new()),
                Verdict::Unmet(d) => ("UNMET", d.clone()),
                Verdict::NotExercised(d) => ("not exercised", d.clone()),
            };
            out.push_str(&format!(
                "{label:<13} {:<52} {:>6.2}s  [{}] {detail}\n",
                ran.check.name,
                ran.took.as_secs_f64(),
                ran.check.sentences.join(" "),
            ));
        }
        out.push_str(&self.summary());
        out
    }

    /// The table a provider's author reads: every sentence, its status, and why.
    pub fn table(&self) -> String {
        let cell = |text: &str| text.replace('|', "\\|").replace('\n', " ");
        let mut out =
            String::from("| id | sentence | status | detail |\n| --- | --- | --- | --- |\n");
        for sentence in SENTENCES {
            if let Some((status, detail)) = self.status(sentence) {
                out.push_str(&format!(
                    "| {} | {} | {} | {} |\n",
                    sentence.id,
                    cell(sentence.text),
                    status.label(),
                    cell(&detail)
                ));
            }
        }
        out.push('\n');
        out.push_str(&self.summary());
        out
    }

    pub fn summary(&self) -> String {
        let mut by_status = [0usize; 4];
        for sentence in SENTENCES {
            if let Some((status, _)) = self.status(sentence) {
                by_status[status as usize] += 1;
            }
        }
        let count = |f: fn(&Verdict) -> bool| self.ran.iter().filter(|r| f(&r.verdict)).count();
        format!(
            "checks: {} met, {} unmet, {} not exercised; sentences: {} met, {} unmet, {} not exercised, {} not checkable from outside; {:.1}s\n",
            count(|v| matches!(v, Verdict::Met)),
            count(|v| matches!(v, Verdict::Unmet(_))),
            count(|v| matches!(v, Verdict::NotExercised(_))),
            by_status[Status::Met as usize],
            by_status[Status::Unmet as usize],
            by_status[Status::NotExercised as usize],
            by_status[Status::NotCheckable as usize],
            self.took.as_secs_f64(),
        )
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    #[test]
    fn every_sentence_is_decided_by_checks_or_says_why_not() {
        let ids: BTreeSet<&str> = SENTENCES.iter().map(|s| s.id).collect();
        assert_eq!(ids.len(), SENTENCES.len(), "sentence ids are unique");
        let names: BTreeSet<&str> = CHECKS.iter().map(|c| c.name).collect();
        assert_eq!(names.len(), CHECKS.len(), "check names are unique");
        for check in CHECKS {
            assert!(
                !check.sentences.is_empty(),
                "{} decides no sentence",
                check.name
            );
            for id in check.sentences {
                assert!(
                    ids.contains(id),
                    "{} names unknown sentence {id}",
                    check.name
                );
            }
        }
        for sentence in SENTENCES {
            let decided = CHECKS.iter().any(|c| c.sentences.contains(&sentence.id));
            match sentence.not_checkable {
                None => assert!(decided, "{} has no check", sentence.id),
                Some(_) => assert!(!decided, "{} is not checkable yet has a check", sentence.id),
            }
        }
    }

    #[test]
    fn every_sentence_is_written_in_the_contract() {
        let contract = include_str!("../../../STORAGE.md");
        for sentence in SENTENCES {
            for cell in sentence.text.split(" | ") {
                assert!(
                    contract.contains(cell),
                    "{} is not in STORAGE.md as written: {cell}",
                    sentence.id
                );
            }
        }
    }
}
