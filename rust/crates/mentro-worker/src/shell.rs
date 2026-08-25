//! Cargo-style dual-stream output: human status -> stderr, machine
//! results -> stdout. `--quiet` hides status but never errors.

#[derive(Debug, Default)]
pub struct Shell {
    #[allow(dead_code)] // wired into the M1 progress renderer
    pub verbose: u8,
    pub quiet: bool,
}

impl Shell {
    pub fn status(&self, message: &str) {
        if !self.quiet {
            eprintln!("    {message}");
        }
    }

    pub fn warn(&self, message: &str) {
        eprintln!("    {message}");
    }

    pub fn result(&self, json: &serde_json::Value) {
        println!("{json}");
    }
}
