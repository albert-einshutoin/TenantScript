# Security boundaries

- Treat every ticket payload as untrusted. The template accepts only a bounded string subject and a fixed priority enum, and returns a fixed error for invalid input.
- The output intentionally drops unknown fields so customer or tenant-specific data is not copied by default.
- The manifest declares no capabilities and denies egress. Add access only after documenting and testing the minimum required grant.
- This is a synthetic submission used to verify the public contribution flow. It is not a community endorsement, security certification, independent audit, or live deployment proof.
