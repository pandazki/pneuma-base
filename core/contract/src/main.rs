//! `pneuma-base-contract --provider <path> [--report] [--filter <text>]`: checks a storage
//! provider against `STORAGE.md`. Plain mode prints one line per check; `--report` prints every
//! sentence with its status. The exit status is 1 when any check is unmet, 2 for a wrong command
//! line.

use std::path::PathBuf;
use std::process::ExitCode;

const USAGE: &str = "usage: pneuma-base-contract --provider <path> [--report] [--filter <text>]";

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    let (mut provider, mut report, mut filter) = (None, false, None);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--provider" => provider = args.next().map(PathBuf::from),
            "--report" => report = true,
            "--filter" => filter = args.next(),
            "--help" | "-h" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            _ => {
                eprintln!("{USAGE}");
                return ExitCode::from(2);
            }
        }
    }
    let Some(provider) = provider.filter(|p| p.is_file()) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    let provider = provider.canonicalize().unwrap_or(provider);
    let result = pneuma_base_contract::run(&provider, filter.as_deref());
    if report {
        print!("{}", result.table());
    } else {
        print!("{}", result.lines());
    }
    if result.unmet() > 0 {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}
