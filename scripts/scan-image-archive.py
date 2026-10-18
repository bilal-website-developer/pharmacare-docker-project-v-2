import re
import sys
import tarfile
from pathlib import PurePosixPath


RULES = (
    ("Supabase URL", re.compile(r"https?://[a-z0-9-]+\.supabase\.(?:co|in)\b", re.I)),
    ("Supabase key", re.compile(r"\bsb_(?:publishable|secret)_[A-Za-z0-9._-]{8,}\b")),
    ("JWT-like value", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
    (
        "Private key",
        re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |ED25519 |ENCRYPTED )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{80,}?-----END (?:RSA |EC |OPENSSH |ED25519 |ENCRYPTED )?PRIVATE KEY-----"),
    ),
    (
        "Secret environment assignment",
        re.compile(r"^\s*(?:SUPABASE|VITE_SUPABASE)_[A-Z0-9_]*(?:KEY|TOKEN|URL)\s*[:=]\s*[\"']?[^\"'\s#]{3,}", re.I | re.M),
    ),
    ("Credential-like API key", re.compile(r"\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b")),
)
TEXT_EXTENSIONS = {
    ".cjs", ".conf", ".css", ".html", ".ini", ".js", ".json", ".md", ".mjs",
    ".pem", ".properties", ".ps1", ".sh", ".sql", ".svg", ".toml", ".ts",
    ".txt", ".xml", ".yaml", ".yml",
}
MAX_TEXT_SIZE = 32 * 1024 * 1024


def is_environment_file(name: str) -> bool:
    basename = PurePosixPath(name).name
    return basename == ".env" or basename.startswith(".env.")


def scan_archive(path: str) -> list[tuple[str, str]]:
    findings: list[tuple[str, str]] = []
    with tarfile.open(path, mode="r|*") as archive:
        for member in archive:
            if is_environment_file(member.name):
                findings.append(("Environment file", member.name))
                continue
            if not member.isfile() or member.size > MAX_TEXT_SIZE:
                continue
            extension = PurePosixPath(member.name).suffix.lower()
            if extension and extension not in TEXT_EXTENSIONS:
                continue
            stream = archive.extractfile(member)
            if stream is None:
                continue
            sample = stream.read(MAX_TEXT_SIZE)
            if b"\x00" in sample[:8192]:
                continue
            text = sample.decode("utf-8", errors="ignore")
            for label, pattern in RULES:
                if pattern.search(text):
                    findings.append((label, member.name))
    return findings


def main() -> int:
    if len(sys.argv) != 2:
        print("Usage: scan-image-archive.py <docker-export.tar>", file=sys.stderr)
        return 2
    try:
        findings = scan_archive(sys.argv[1])
    except (OSError, tarfile.TarError) as error:
        print(f"Could not inspect image archive ({type(error).__name__}).", file=sys.stderr)
        return 2
    if findings:
        print(f"Image scan failed with {len(findings)} finding(s):")
        for label, name in findings:
            print(f"{label}: {name}")
        return 1
    print("No .env files, Supabase URLs/keys, JWT-like values, or private keys found.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
