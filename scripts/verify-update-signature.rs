use minisign_verify::{PublicKey, Signature};
use std::{env, fs::File, io::Read, path::Path};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let arguments: Vec<String> = env::args().collect();
    let key = PublicKey::from_file(Path::new(&arguments[1]))?;
    let signature = Signature::from_file(Path::new(&arguments[2]))?;
    let mut verifier = key.verify_stream(&signature)?;
    let mut input = File::open(&arguments[3])?;
    let mut buffer = [0u8; 65536];
    loop {
        let count = input.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        verifier.update(&buffer[..count]);
    }
    verifier.finalize()?;
    println!("Update signature verified");
    Ok(())
}
