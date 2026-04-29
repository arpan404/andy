use std::io::{BufRead, BufReader, Write};
use std::process::{Command, Stdio};

use anyhow::{bail, Context, Result};
use protocol::{CliRequest, CliResponse};

fn main() -> Result<()> {
    let mut args = std::env::args();
    let _bin = args.next();

    if args.next().as_deref() == Some("ping") {
        ping_cli_backend()
    } else {
        eprintln!("usage: desktop ping");
        bail!("invalid arguments")
    }
}

fn ping_cli_backend() -> Result<()> {
    let mut child = spawn_cli_server()?;

    let mut stdin = child.stdin.take().context("failed to capture cli stdin for IPC")?;
    let stdout = child.stdout.take().context("failed to capture cli stdout for IPC")?;
    let mut stdout_reader = BufReader::new(stdout);

    let request = CliRequest::Ping { id: String::from("desktop") };
    let request_json = serde_json::to_string(&request).context("failed to encode request")?;
    writeln!(stdin, "{request_json}").context("failed to send request")?;
    stdin.flush().context("failed to flush request")?;

    let mut line = String::new();
    stdout_reader.read_line(&mut line).context("failed to read CLI response")?;

    let response: CliResponse =
        serde_json::from_str(line.trim()).context("failed to decode CLI response")?;
    match response {
        CliResponse::Pong { id, ok } => {
            println!("desktop received pong: id={id} ok={ok}");
        }
        CliResponse::Error { message } => {
            bail!("cli error: {message}");
        }
    }

    let _ = child.kill();
    Ok(())
}

fn spawn_cli_server() -> Result<std::process::Child> {
    let cli_bin = std::env::var("ANDY_CLI_BIN").ok().filter(|value| !value.is_empty());

    if let Some(path) = cli_bin {
        return Command::new(path)
            .args(["serve", "--stdio"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("failed to spawn cli backend from ANDY_CLI_BIN");
    }

    Command::new("cargo")
        .args(["run", "--quiet", "-p", "cli", "--", "serve", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .context("failed to spawn cli backend via cargo")
}
