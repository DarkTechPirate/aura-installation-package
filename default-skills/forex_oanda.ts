/** OANDA v20 REST API client — forex, metals, indices. */

export interface OandaAccount {
  id:            string;
  balance:       number;
  nav:           number;           // net asset value
  unrealizedPL:  number;
  realizedPL:    number;
  marginUsed:    number;
  marginAvail:   number;
  openTradeCount: number;
  currency:      string;
}

export interface OandaTrade {
  id:            string;
  instrument:    string;
  units:         number;           // negative = short
  price:         number;           // entry price
  currentPrice:  number;
  unrealizedPL:  number;
  initialUnits:  number;
  stopLossOrder?: { price: number };
  takeProfitOrder?: { price: number };
  openTime:      string;
}

export interface OandaOrder {
  id:         string;
  instrument: string;
  type:       string;
  units:      number;
  price?:     number;
  state:      string;
  createTime: string;
}

export interface OandaCandle {
  time: string;
  mid:  { o: string; h: string; l: string; c: string };
  volume: number;
}

export interface OandaPrice {
  instrument: string;
  bid:        number;
  ask:        number;
  mid:        number;
  spread:     number;
  tradeable:  boolean;
}

export class OandaClient {
  private baseUrl:   string;
  private accountId: string;
  private headers:   Record<string, string>;

  constructor() {
    const token     = process.env['OANDA_API_TOKEN'];
    const accountId = process.env['OANDA_ACCOUNT_ID'];
    const practice  = (process.env['OANDA_PRACTICE'] ?? 'true') !== 'false';
    if (!token || !accountId) {
      throw new Error('OANDA_API_TOKEN and OANDA_ACCOUNT_ID are required. Sign up free at oanda.com.');
    }
    this.accountId = accountId;
    this.baseUrl   = practice
      ? 'https://api-fxpractice.oanda.com'
      : 'https://api-fxtrade.oanda.com';
    this.headers = {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    };
  }

  /** Normalise instrument: eurusd → EUR_USD, xauusd → XAU_USD */
  static normalise(instrument: string): string {
    const s = instrument.toUpperCase().replace(/[^A-Z]/g, '');
    if (s.length === 6) return `${s.slice(0, 3)}_${s.slice(3)}`;
    return s.includes('_') ? s : instrument.toUpperCase();
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`OANDA ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  async getAccount(): Promise<OandaAccount> {
    const d = await this.req<Record<string, unknown>>('GET', `/v3/accounts/${this.accountId}/summary`);
    const a = d['account'] as Record<string, unknown>;
    return {
      id:             String(a['id']),
      balance:        parseFloat(String(a['balance'])),
      nav:            parseFloat(String(a['NAV'])),
      unrealizedPL:   parseFloat(String(a['unrealizedPL'])),
      realizedPL:     parseFloat(String(a['pl'])),
      marginUsed:     parseFloat(String(a['marginUsed'])),
      marginAvail:    parseFloat(String(a['marginAvailable'])),
      openTradeCount: Number(a['openTradeCount']),
      currency:       String(a['currency']),
    };
  }

  async getTrades(): Promise<OandaTrade[]> {
    const d = await this.req<Record<string, unknown>>('GET', `/v3/accounts/${this.accountId}/openTrades`);
    const trades = (d['trades'] as Record<string, unknown>[]) ?? [];
    return trades.map(t => ({
      id:           String(t['id']),
      instrument:   String(t['instrument']),
      units:        parseFloat(String(t['currentUnits'])),
      price:        parseFloat(String(t['price'])),
      currentPrice: parseFloat(String((t['unrealizedPL'] as unknown) ?? '0')), // resolved below
      unrealizedPL: parseFloat(String(t['unrealizedPL'])),
      initialUnits: parseFloat(String(t['initialUnits'])),
      stopLossOrder:    t['stopLossOrder']   ? { price: parseFloat(String((t['stopLossOrder'] as Record<string,unknown>)['price'])) } : undefined,
      takeProfitOrder:  t['takeProfitOrder'] ? { price: parseFloat(String((t['takeProfitOrder'] as Record<string,unknown>)['price'])) } : undefined,
      openTime:     String(t['openTime']),
    }));
  }

  async getOrders(): Promise<OandaOrder[]> {
    const d = await this.req<Record<string, unknown>>('GET', `/v3/accounts/${this.accountId}/pendingOrders`);
    const orders = (d['orders'] as Record<string, unknown>[]) ?? [];
    return orders.map(o => ({
      id:         String(o['id']),
      instrument: String(o['instrument'] ?? ''),
      type:       String(o['type']),
      units:      parseFloat(String(o['units'] ?? '0')),
      price:      o['price'] ? parseFloat(String(o['price'])) : undefined,
      state:      String(o['state']),
      createTime: String(o['createTime']),
    }));
  }

  async getPrice(instrument: string): Promise<OandaPrice> {
    const inst = OandaClient.normalise(instrument);
    const d    = await this.req<Record<string, unknown>>(
      'GET', `/v3/accounts/${this.accountId}/pricing?instruments=${inst}`
    );
    const prices = (d['prices'] as Record<string, unknown>[]) ?? [];
    const p = prices[0] ?? {};
    const bid = parseFloat(String(p['bids'] && (p['bids'] as Record<string,unknown>[])[0]?.['price'] || '0'));
    const ask = parseFloat(String(p['asks'] && (p['asks'] as Record<string,unknown>[])[0]?.['price'] || '0'));
    return {
      instrument: inst,
      bid, ask,
      mid:        (bid + ask) / 2,
      spread:     parseFloat((ask - bid).toFixed(5)),
      tradeable:  Boolean(p['tradeable']),
    };
  }

  async getCandles(instrument: string, granularity = 'D', count = 100): Promise<OandaCandle[]> {
    const inst = OandaClient.normalise(instrument);
    const d    = await this.req<Record<string, unknown>>(
      'GET', `/v3/instruments/${inst}/candles?granularity=${granularity}&count=${count}&price=M`
    );
    return ((d['candles'] as Record<string, unknown>[]) ?? []).map(c => ({
      time:   String(c['time']),
      mid:    c['mid'] as { o: string; h: string; l: string; c: string },
      volume: Number(c['volume']),
    }));
  }

  async placeMarketOrder(params: {
    instrument: string;
    units:      number;       // positive = long, negative = short
    stopLoss?:  number;
    takeProfit?: number;
  }): Promise<{ orderId: string; tradeId?: string; price?: number }> {
    const inst = OandaClient.normalise(params.instrument);
    const body: Record<string, unknown> = {
      order: {
        type:       'MARKET',
        instrument: inst,
        units:      String(params.units),
        timeInForce: 'FOK',
        ...(params.stopLoss   ? { stopLossOnFill:   { price: params.stopLoss.toFixed(5) } } : {}),
        ...(params.takeProfit ? { takeProfitOnFill: { price: params.takeProfit.toFixed(5) } } : {}),
      },
    };
    const d = await this.req<Record<string, unknown>>(
      'POST', `/v3/accounts/${this.accountId}/orders`, body
    );
    const fill = d['orderFillTransaction'] as Record<string, unknown> | undefined;
    return {
      orderId:  String((d['relatedTransactionIDs'] as string[])?.[0] ?? ''),
      tradeId:  fill ? String(fill['tradeOpened'] && (fill['tradeOpened'] as Record<string,unknown>)['tradeID']) : undefined,
      price:    fill ? parseFloat(String(fill['price'])) : undefined,
    };
  }

  async placeLimitOrder(params: {
    instrument:  string;
    units:       number;
    price:       number;
    stopLoss?:   number;
    takeProfit?: number;
  }): Promise<{ orderId: string }> {
    const inst = OandaClient.normalise(params.instrument);
    const body = {
      order: {
        type:       'LIMIT',
        instrument: inst,
        units:      String(params.units),
        price:      params.price.toFixed(5),
        timeInForce: 'GTC',
        ...(params.stopLoss   ? { stopLossOnFill:   { price: params.stopLoss.toFixed(5) } } : {}),
        ...(params.takeProfit ? { takeProfitOnFill: { price: params.takeProfit.toFixed(5) } } : {}),
      },
    };
    const d = await this.req<Record<string, unknown>>(
      'POST', `/v3/accounts/${this.accountId}/orders`, body
    );
    return { orderId: String((d['relatedTransactionIDs'] as string[])?.[0] ?? '') };
  }

  async closeTrade(tradeId: string, units?: number): Promise<void> {
    const body = units ? { units: String(Math.abs(units)) } : { units: 'ALL' };
    await this.req('PUT', `/v3/accounts/${this.accountId}/trades/${tradeId}/close`, body);
  }

  async updateTradeSLTP(tradeId: string, stopLoss?: number, takeProfit?: number): Promise<void> {
    const body: Record<string, unknown> = {};
    if (stopLoss)   body['stopLoss']   = { price: stopLoss.toFixed(5),   timeInForce: 'GTC' };
    if (takeProfit) body['takeProfit'] = { price: takeProfit.toFixed(5), timeInForce: 'GTC' };
    await this.req('PUT', `/v3/accounts/${this.accountId}/trades/${tradeId}/orders`, body);
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.req('PUT', `/v3/accounts/${this.accountId}/orders/${orderId}/cancel`);
  }
}

/** Known pip sizes for common instruments. */
export function pipSize(instrument: string): number {
  const inst = OandaClient.normalise(instrument);
  if (inst.startsWith('XAU') || inst.startsWith('XAG')) return 0.01; // metals: 1 pip = $0.01
  if (inst.includes('JPY')) return 0.01;
  return 0.0001; // standard forex
}

/** Units to risk at most `riskPct`% of balance given SL distance. */
export function calcForexUnits(
  balance:       number,
  entryPrice:    number,
  stopPrice:     number,
  riskPct        = 2,
): number {
  const riskAmount   = balance * (riskPct / 100);
  const riskPerUnit  = Math.abs(entryPrice - stopPrice);
  if (riskPerUnit <= 0) return 0;
  return Math.floor(riskAmount / riskPerUnit);
}
