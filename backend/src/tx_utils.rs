use anyhow::Context;
use solana_sdk::hash::Hash;
use solana_sdk::instruction::{AccountMeta, Instruction};
use solana_sdk::pubkey::Pubkey;
use std::str::FromStr;

pub const TOKEN_PROGRAM_ID: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
pub const ATA_PROGRAM_ID: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
pub const SYSTEM_PROGRAM_ID_BYTES: [u8; 32] = [0u8; 32];

pub fn decimal_to_q64(s: &str) -> anyhow::Result<u128> {
    let s = s.trim();
    anyhow::ensure!(!s.is_empty(), "empty decimal");
    let (int_part, frac_part) = match s.find('.') {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, ""),
    };
    let int: u128 = if int_part.is_empty() {
        0
    } else {
        int_part.parse()?
    };
    let mut q64 = int
        .checked_shl(64)
        .ok_or_else(|| anyhow::anyhow!("decimal integer part overflows u128"))?;
    if !frac_part.is_empty() {
        let frac_digits = frac_part.len() as u32;
        anyhow::ensure!(frac_digits <= 18, "too many fractional digits");
        let frac_num: u128 = frac_part.parse()?;
        let frac_den: u128 = 10u128.pow(frac_digits);
        let frac_q64 = frac_num
            .checked_shl(64)
            .ok_or_else(|| anyhow::anyhow!("decimal fractional part overflows"))?
            / frac_den;
        q64 = q64
            .checked_add(frac_q64)
            .ok_or_else(|| anyhow::anyhow!("decimal sum overflows u128"))?;
    }
    Ok(q64)
}

pub fn decimal_to_u64_scaled(s: &str, decimals: u32) -> anyhow::Result<u64> {
    let s = s.trim();
    anyhow::ensure!(!s.is_empty(), "empty decimal");
    let (int_part, frac_part) = match s.find('.') {
        Some(i) => (&s[..i], &s[i + 1..]),
        None => (s, ""),
    };
    let int: u128 = if int_part.is_empty() {
        0
    } else {
        int_part.parse()?
    };
    let frac_digits = frac_part.len() as u32;
    let mut frac: u128 = if frac_part.is_empty() {
        0
    } else {
        frac_part.parse()?
    };
    if frac_digits < decimals {
        frac = frac
            .checked_mul(10u128.pow(decimals - frac_digits))
            .ok_or_else(|| anyhow::anyhow!("overflow"))?;
    } else if frac_digits > decimals {
        frac /= 10u128.pow(frac_digits - decimals);
    }
    let scale = 10u128.pow(decimals);
    let total = int
        .checked_mul(scale)
        .and_then(|v| v.checked_add(frac))
        .ok_or_else(|| anyhow::anyhow!("amount overflows u64"))?;
    anyhow::ensure!(total <= u64::MAX as u128, "amount overflows u64");
    Ok(total as u64)
}

pub fn derive_ata(owner: &Pubkey, mint: &Pubkey) -> Pubkey {
    let token_program = Pubkey::from_str(TOKEN_PROGRAM_ID).expect("const pubkey");
    let ata_program = Pubkey::from_str(ATA_PROGRAM_ID).expect("const pubkey");
    Pubkey::find_program_address(
        &[owner.as_ref(), token_program.as_ref(), mint.as_ref()],
        &ata_program,
    )
    .0
}

pub fn create_ata_idempotent_ix(
    payer: &Pubkey,
    ata: &Pubkey,
    owner: &Pubkey,
    mint: &Pubkey,
) -> anyhow::Result<Instruction> {
    let token_program = Pubkey::from_str(TOKEN_PROGRAM_ID)?;
    let ata_program = Pubkey::from_str(ATA_PROGRAM_ID)?;
    let system_program = Pubkey::new_from_array(SYSTEM_PROGRAM_ID_BYTES);
    Ok(Instruction {
        program_id: ata_program,
        accounts: vec![
            AccountMeta::new(*payer, true),
            AccountMeta::new(*ata, false),
            AccountMeta::new_readonly(*owner, false),
            AccountMeta::new_readonly(*mint, false),
            AccountMeta::new_readonly(system_program, false),
            AccountMeta::new_readonly(token_program, false),
        ],
        data: vec![1u8],
    })
}

pub fn bs58_to_hash(s: &str) -> anyhow::Result<Hash> {
    let bytes = bs58::decode(s).into_vec()?;
    anyhow::ensure!(bytes.len() == 32, "bad blockhash length");
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&bytes);
    Ok(Hash::new_from_array(arr))
}

pub fn token_program_id() -> anyhow::Result<Pubkey> {
    Pubkey::from_str(TOKEN_PROGRAM_ID).context("invalid token program id constant")
}

pub fn system_program_id() -> Pubkey {
    Pubkey::new_from_array(SYSTEM_PROGRAM_ID_BYTES)
}

/// Anchor instruction discriminator: sha256("global:<name>")[..8].
pub fn ix_discriminator(name: &str) -> [u8; 8] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(format!("global:{name}").as_bytes());
    let h = hasher.finalize();
    let mut out = [0u8; 8];
    out.copy_from_slice(&h[..8]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn q64_conversion_roundtrip() {
        let q = decimal_to_q64("0.5").unwrap();
        assert_eq!(q, 1u128 << 63);
        let q = decimal_to_q64("1").unwrap();
        assert_eq!(q, 1u128 << 64);
    }

    #[test]
    fn u64_scaled_basic() {
        assert_eq!(decimal_to_u64_scaled("1000", 6).unwrap(), 1_000_000_000);
        assert_eq!(decimal_to_u64_scaled("1.5", 6).unwrap(), 1_500_000);
        assert_eq!(decimal_to_u64_scaled("0.000001", 6).unwrap(), 1);
        assert_eq!(decimal_to_u64_scaled("42", 0).unwrap(), 42);
    }
}
