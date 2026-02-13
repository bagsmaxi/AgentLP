/**
 * OpenClaw MCP Tools for Meteora LP Agent
 *
 * These tools can be registered as MCP tools in OpenClaw for chat-based
 * interaction with the Meteora LP agent.
 *
 * Usage: Register this as an MCP server in your OpenClaw config:
 * {
 *   "mcp": {
 *     "servers": {
 *       "meteora-lp": {
 *         "command": "node",
 *         "args": ["path/to/meteora-tools.js"]
 *       }
 *     }
 *   }
 * }
 */

// Tool definitions for MCP registration
export const TOOL_DEFINITIONS = [
  {
    name: 'meteora_analyze_pools',
    description: 'Analyze and rank all SOL-paired DLMM pools on Meteora. Returns top pools scored by volume, fees, APR, and historical performance.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of top pools to return (default: 10)',
          default: 10,
        },
      },
    },
  },
  {
    name: 'meteora_create_position',
    description: 'Create an optimized single-sided SOL LP position on Meteora DLMM. Agent selects the best strategy and bin range automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        poolAddress: {
          type: 'string',
          description: 'Pool address to LP into. If not provided, agent picks the best pool.',
        },
        solAmount: {
          type: 'number',
          description: 'Amount of SOL to deposit',
        },
        walletAddress: {
          type: 'string',
          description: 'Wallet public key',
        },
      },
      required: ['solAmount', 'walletAddress'],
    },
  },
  {
    name: 'meteora_get_positions',
    description: 'Get all LP positions for a wallet address, including status, fees earned, and strategy info.',
    inputSchema: {
      type: 'object',
      properties: {
        walletAddress: {
          type: 'string',
          description: 'Wallet public key to query positions for',
        },
      },
      required: ['walletAddress'],
    },
  },
  {
    name: 'meteora_check_position',
    description: 'Check if a specific position is in range and show current status.',
    inputSchema: {
      type: 'object',
      properties: {
        positionPubkey: {
          type: 'string',
          description: 'Position public key to check',
        },
      },
      required: ['positionPubkey'],
    },
  },
  {
    name: 'meteora_claim_fees',
    description: 'Claim accumulated swap fees and LM rewards for all positions in a pool.',
    inputSchema: {
      type: 'object',
      properties: {
        walletAddress: {
          type: 'string',
          description: 'Wallet public key',
        },
        poolAddress: {
          type: 'string',
          description: 'Pool address to claim fees from',
        },
      },
      required: ['walletAddress', 'poolAddress'],
    },
  },
  {
    name: 'meteora_get_analytics',
    description: 'Get performance analytics including total fees earned, ROI, strategy performance, and learning insights.',
    inputSchema: {
      type: 'object',
      properties: {
        walletAddress: {
          type: 'string',
          description: 'Wallet public key',
        },
      },
      required: ['walletAddress'],
    },
  },
];

/**
 * Tool handler implementations.
 * These call the same backend API as the web frontend.
 */
const API_BASE = process.env.AGENT_LP_API || 'http://localhost:3001';

async function callApi(path: string, method = 'GET', body?: any) {
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${path}`, options);
  const json = await res.json();
  if (!json.success) throw new Error(json.error);
  return json.data;
}

export async function handleTool(name: string, input: any): Promise<string> {
  switch (name) {
    case 'meteora_analyze_pools': {
      const pools = await callApi(`/api/pools?limit=${input.limit || 10}`);
      return formatPoolsResponse(pools);
    }
    case 'meteora_create_position': {
      if (input.poolAddress) {
        const result = await callApi('/api/positions/create', 'POST', {
          walletAddress: input.walletAddress,
          poolAddress: input.poolAddress,
          solAmount: input.solAmount,
        });
        return `Position created!\nPool: ${result.strategy?.strategyType || 'auto'}\nPosition: ${result.positionPubkey}\nSignature: ${result.signature || 'Pending wallet sign'}`;
      } else {
        const result = await callApi('/api/agent/start', 'POST', {
          walletAddress: input.walletAddress,
          mode: 'auto',
          solAmount: input.solAmount,
        });
        return `Auto-mode started!\nSelected pool: ${result.selectedPool?.name}\nScore: ${result.selectedPool?.score?.toFixed(4)}\nSession: ${result.sessionId}`;
      }
    }
    case 'meteora_get_positions': {
      const positions = await callApi(`/api/positions?wallet=${input.walletAddress}`);
      return formatPositionsResponse(positions);
    }
    case 'meteora_get_analytics': {
      const analytics = await callApi(`/api/analytics?wallet=${input.walletAddress}`);
      return formatAnalyticsResponse(analytics);
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

function formatPoolsResponse(pools: any[]): string {
  if (!pools.length) return 'No SOL pools found matching criteria.';
  return pools
    .map(
      (p: any, i: number) =>
        `#${i + 1} ${p.name}\n   Score: ${p.score?.toFixed(3)} | APR: ${p.feeApr?.toFixed(1)}% | Vol: $${(p.volume24h / 1000).toFixed(0)}K | Fees: $${(p.fees24h / 1000).toFixed(1)}K\n   Strategy: ${p.suggestedStrategy} | Volatility: ${p.volatility}\n   Address: ${p.address}`
    )
    .join('\n\n');
}

function formatPositionsResponse(positions: any[]): string {
  if (!positions.length) return 'No active positions.';
  return positions
    .map(
      (p: any) =>
        `${p.poolName} [${p.status}]\n   Deposited: ${p.solDeposited} SOL | Fees: +${p.totalFeesEarned.toFixed(6)} SOL\n   Strategy: ${p.strategy} | Bins: ${p.minBinId}-${p.maxBinId}\n   Rebalanced: ${p.rebalanceCount}x | Since: ${new Date(p.createdAt).toLocaleDateString()}`
    )
    .join('\n\n');
}

function formatAnalyticsResponse(analytics: any): string {
  const s = analytics.summary;
  return `Performance Summary:\n   Total Deposited: ${s.totalSolDeposited?.toFixed(2)} SOL\n   Total Earned: ${s.totalReturn?.toFixed(4)} SOL\n   Active Positions: ${s.activePositions}\n   Total Rebalances: ${s.totalRebalances}\n\nOutcomes: ${analytics.outcomes.profit} profit / ${analytics.outcomes.loss} loss / ${analytics.outcomes.breakeven} breakeven`;
}
