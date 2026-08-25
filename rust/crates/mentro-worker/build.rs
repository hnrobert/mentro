// Compiles the worker protocol from the buf-produced descriptor set —
// no protoc involved. Regenerate with `pnpm gen:proto`.
use std::{env, path::PathBuf};

use prost::Message;

fn main() {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let descriptor = manifest_dir.join("../../../packages/protocol/descriptor.bin");
    println!("cargo:rerun-if-changed={}", descriptor.display());

    if !descriptor.exists() {
        panic!("packages/protocol/descriptor.bin not found — run `pnpm gen:proto` first");
    }

    let bytes = std::fs::read(&descriptor).expect("read descriptor.bin");
    let fds =
        prost_types::FileDescriptorSet::decode(bytes.as_slice()).expect("decode FileDescriptorSet");

    prost_build::Config::new()
        .compile_fds(fds)
        .expect("compile worker protocol");
}
