use std::env;
use std::path::PathBuf;

fn main() {
    let mut args = env::args().skip(1);
    match args.next().as_deref() {
        Some("init") => {
            let output = args
                .next()
                .map(PathBuf::from)
                .unwrap_or_else(xuan_bridge::config_root);
            match xuan_bridge::initialize_storage(&output) {
                Ok(value) => println!("{value}"),
                Err(error) => {
                    eprintln!("storage initialization failed: {error}");
                    std::process::exit(1);
                }
            }
        }
        _ => {
            if let Err(error) = xuan_bridge::initialize_storage(&xuan_bridge::config_root()) {
                eprintln!("xuan-bridge storage initialization failed: {error}");
                std::process::exit(1);
            }
            if let Err(error) = xuan_bridge::serve_json_lines(std::io::stdin(), std::io::stdout()) {
                eprintln!("xuan-bridge failed: {error}");
                std::process::exit(1);
            }
        }
    }
}
