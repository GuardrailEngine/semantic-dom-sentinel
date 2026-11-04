# Security policy

Semantic DOM Sentinel is an early-stage monitoring library, not a security boundary. Do not rely on it to prevent exploitation or protect a compromised page.

## Reporting a vulnerability

Please report suspected vulnerabilities using GitHub's private vulnerability reporting for this repository when available. Include a minimal reproduction, the affected version, browser/runtime details, and the impact you observed. Avoid attaching real personal data, payment details, or production secrets.

Please do not publish an unpatched exploit in a public issue. We will review reports and coordinate a fix and disclosure timeline where practical.

## Scope notes

The library intentionally makes no network requests and never repairs or blocks DOM changes. It cannot reliably resist privileged browser extensions or hostile scripts executing in the page. Cross-origin iframe documents are outside its observation scope. These are known limitations, not vulnerabilities by themselves.
