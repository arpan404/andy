use std::io::{self, BufRead, Write};

use anyhow::{bail, Context, Result};
use protocol::{CliRequest, CliResponse};

fn main() -> Result<()> {
    let mut args = std::env::args();
    let _bin = args.next();

    match (args.next().as_deref(), args.next().as_deref()) {
        (Some("serve"), Some("--stdio")) => run_stdio_server(),
        (Some("ping"), None) => {
            let response = CliResponse::Pong { id: String::from("manual"), ok: true };
            println!("{}", serde_json::to_string(&response)?);
            Ok(())
        }
        _ => {
            eprintln!("usage: cli serve --stdio | cli ping");
            bail!("invalid arguments")
        }
    }
}

fn run_stdio_server() -> Result<()> {
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();

    for line in stdin.lock().lines() {
        let line = line.context("failed to read input line")?;
        if line.trim().is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<CliRequest>(&line) {
            Ok(CliRequest::Ping { id }) => CliResponse::Pong { id, ok: true },
            Err(error) => CliResponse::Error { message: format!("invalid request: {error}") },
        };

        let encoded = serde_json::to_string(&response).context("failed to serialize response")?;
        writeln!(stdout, "{encoded}").context("failed to write response")?;
        stdout.flush().context("failed to flush response")?;
    }

    Ok(())
}
