# Security Policy

## Reporting a Vulnerability

Please report security vulnerabilities responsibly via GitHub Security Advisories or repository issues without publishing exploit details prior to a patch.

## Implemented Controls

- **Credential Encryption at Rest:** Connection strings and database passwords are encrypted with AES-256-GCM (key derived via SHA-256 of `QUERYPILOT_MASTER_KEY`) before persisting to SQLite.
- **Read-Only Connection Guard:** Connections flagged `read_only = true` reject mutating DDL/DML/PRAGMA/ATTACH statements (`INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `REPLACE`, `MERGE`, `GRANT`, `REVOKE`, `VACUUM`) before hitting the driver.
- **SQL Identifier Quoting:** Table browser and data pagination validate and dialect-quote table/column identifiers to prevent identifier injection.
- **Authentication & RBAC:** PBKDF2/scrypt salted password hashing, HMAC JWT sessions, and `admin` / `editor` / `viewer` roles.
