use anchor_lang::prelude::*;

use crate::error::PortalError;
use crate::events::StealthSolVaultPrepared;
use crate::seeds::{CONFIG_SEED, PORTAL_SEED};
use crate::state::PortalConfig;

pub fn handler(ctx: Context<CreateStealthSol>, owner_hash: [u8; 32]) -> Result<()> {
    emit!(StealthSolVaultPrepared {
        owner_hash,
        recovery: ctx.accounts.recovery.key(),
        vault: ctx.accounts.vault.key(),
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(owner_hash: [u8; 32])]
pub struct CreateStealthSol<'info> {
    #[account(
        mut,
        constraint = operator.key() == config.operator @ PortalError::UnauthorizedOperator,
    )]
    pub operator: Signer<'info>,

    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        constraint = !config.paused @ PortalError::Paused,
    )]
    pub config: Account<'info, PortalConfig>,

    /// CHECK: Recovery pubkey (recovery identifier) — part of PDA derivation.
    pub recovery: UncheckedAccount<'info>,

    /// CHECK: System-owned vault PDA derived from (owner_hash, recovery).
    #[account(
        seeds = [PORTAL_SEED, owner_hash.as_ref(), recovery.key().as_ref()],
        bump,
        constraint = owner_hash != [0u8; 32] @ PortalError::InvalidOwnerHash,
    )]
    pub vault: UncheckedAccount<'info>,
}

