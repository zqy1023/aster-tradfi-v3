UPDATE user_credentials
SET password_hash = 'scrypt$16384$8$1$MKiZgwOcXUzxMPKJqR5Z3A$EBX8rVsO0HgGq8t8t5PiOmkt1FdCJ47GKZrZfeNFkxg'
WHERE username = 'admin';
