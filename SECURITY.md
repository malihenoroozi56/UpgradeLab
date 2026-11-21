# Security policy

## Supported versions

UpgradeLab is pre-release. Security fixes are applied to the `main` branch; once a stable release exists,
the latest minor line will receive fixes.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Use GitHub's private vulnerability reporting for this repository ("Security" → "Report a vulnerability").
If that is unavailable, contact the maintainers listed in `GOVERNANCE.md` through a private channel.

Include:

- affected version or commit;
- a minimal reproduction, ideally a configuration and Compose file;
- the impact you believe is possible (secret disclosure, host access, false verdict, cleanup damage);
- whether you plan to disclose publicly, and any deadline.

You can expect an acknowledgement within 7 days and a remediation plan within 30 days for confirmed
issues. Please allow time for a fix and a coordinated disclosure before publishing details.

## Scope

In scope:

- container escape primitives caused by UpgradeLab's generated Compose configuration;
- cleanup that removes resources not owned by the run;
- secret leakage through reports, logs, evidence, error messages or AI prompts;
- command injection through configuration, environment values or provider inputs;
- verdict manipulation (for example a run reporting PASSED without checks);
- plugin or provider isolation failures;
- dependency vulnerabilities that are exploitable through UpgradeLab.

Out of scope:

- vulnerabilities in the images or applications being tested (report them upstream);
- a host that grants Docker access to untrusted users, or a compromised Docker daemon;
- denial of service by an image that intentionally consumes its allowed resources;
- users enabling `security.allowNonLoopbackPorts`, `security.allowConfigPlugins` or third-party plugins;
- prompt injection that produces misleading _advisory_ text but cannot change a verdict;
- lack of redaction for secret formats that are not documented or recognisable.

## Safe defaults

- AI is disabled unless both `ai.enabled: true` and `--ai` are present.
- Non-loopback port binding requires `security.allowNonLoopbackPorts: true`.
- Configuration plugins require `security.allowConfigPlugins: true`.
- Plugins outside the project require `allowOutsideProjectRoot`.
- The Docker socket is always rejected as a mount source.
- Cleanup requires label-verified ownership.

See `THREAT_MODEL.md` for the full analysis.
