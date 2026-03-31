use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::error::PortalError;
use crate::events::StealthSplAtaPrepared;
use crate::seeds::{CONFIG_SEED, PORTAL_SEED};
use crate::state::PortalConfig;

pub fn handler(ctx: Context<CreateStealthSplAta>, owner_hash: [u8; 32]) -> Result<()> {
    emit!(StealthSplAtaPrepared {
        owner_hash,
        recovery: ctx.accounts.recovery.key(),
        vault: ctx.accounts.vault.key(),
        mint: ctx.accounts.mint.key(),
        vault_token_account: ctx.accounts.vault_token_account.key(),
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(owner_hash: [u8; 32])]
pub struct CreateStealthSplAta<'info> {
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

    /// CHECK: Vault PDA authority for ATA.
    #[account(
        init_if_needed,
        payer = operator,
        space = 0,
        seeds = [PORTAL_SEED, owner_hash.as_ref(), recovery.key().as_ref()],
        bump,
        constraint = owner_hash != [0u8; 32] @ PortalError::InvalidOwnerHash,
    )]
    pub vault: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init_if_needed,
        payer = operator,
        associated_token::mint = mint,
        associated_token::authority = vault,
    )]
    pub vault_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

