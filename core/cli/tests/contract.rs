//! The contract suite (`core/contract`) run against this binary: every check of every sentence
//! of `STORAGE.md`. `cargo test` fails when any check is unmet. Arguments that are not flags
//! filter the checks by name or sentence id, as `pneuma-base-contract --filter` does.
//!
//! What the suite cannot know of a third-party provider is pinned here for this one: what its
//! `describe` must say on this platform, since the suite takes the cursor and facets from it.

use std::path::Path;
use std::process::ExitCode;

use serde_json::json;

const BIN: &str = env!("CARGO_BIN_EXE_pneuma-base-core");

fn main() -> ExitCode {
    let filter = std::env::args().skip(1).find(|a| !a.starts_with('-'));
    let describe = pneuma_base_contract::Env::new(Path::new(BIN)).describe;
    // On macOS the temporary folder's volume keeps an event history, so the cursor is reliable.
    let (cursor, facets) = if cfg!(target_os = "macos") {
        (true, json!(["fs", "macos", "placeholder"]))
    } else {
        (false, json!(["fs"]))
    };
    let pinned = describe["name"] == "local-folder"
        && describe["addresses"] == json!(["path"])
        && describe["cursor"] == cursor
        && describe["facets"] == facets;
    if !pinned {
        eprintln!("describe is not what this provider says on this platform: {describe}");
        return ExitCode::FAILURE;
    }
    let report = pneuma_base_contract::run(Path::new(BIN), filter.as_deref());
    print!("{}", report.lines());
    if report.unmet() > 0 {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
