//! Generated worker protocol types (from `pnpm gen:proto` → descriptor.bin).
pub mod mentro {
    pub mod worker {
        pub mod v1 {
            #![allow(clippy::all, dead_code)]
            include!(concat!(env!("OUT_DIR"), "/mentro.worker.v1.rs"));
        }
    }
}
