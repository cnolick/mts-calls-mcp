# Public MTS server CA

`mts-class2-root-g2.crt` is a public root certificate, not a client private key.
It was copied unchanged from `res/raw/chain_33_mts_class2_root_ca_g2.crt`
in the original My MTS 6.77 Android APK.

Certificate SHA-256 fingerprint:
`9D:DA:A7:B4:58:0B:DD:5B:5A:E0:C2:7D:30:4F:A7:B3:F0:A0:30:2E:9B:58:FD:78:F4:45:4E:9F:0E:28:E3:27`.

Subject/issuer: `C=RU, O=Mobile TeleSystems PJSC, CN=MTS Class 2 Root CA G2`.
Validity: 2023-06-19 through 2033-06-19.

The dialer endpoint presented `dialer.mts.ru → MTS WinCA G3 → this root`
during the Linux deployment check. The root is added only to the fixed
`dialer.mts.ru` HTTPS client. Server-chain and hostname verification remain
enabled. AuthSSL's client PKCS12 and passphrase are stored separately and
are never included in this repository.
