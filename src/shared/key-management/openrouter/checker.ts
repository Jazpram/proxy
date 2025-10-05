// src/shared/key-management/openrouter/checker.ts

import { AxiosError } from "axios";
import { getAxiosInstance } from "../../network";
import { KeyCheckerBase } from "../key-checker-base";
import type { OpenRouterKey, OpenRouterKeyProvider, OpenRouterKeyStatus } from "./provider";

const axios = getAxiosInstance();

const MIN_CHECK_INTERVAL = 3 * 1000;
const KEY_CHECK_PERIOD = 1000 * 60 * 60 * 24;
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

type KeyInfoResponse = {
  data: {
    is_free_tier: boolean;
    limit_remaining: number | null;
    limit: number | null;
    usage: number; // For free tier
  };
};

type CreditsResponse = {
    data: {
        total_credits: string | number;
        total_usage: string | number;
        // other fields omitted
    };
};

type ErrorResponse = {
  error: { message: string };
};

type KeyInfoResult = KeyInfoResponse | ErrorResponse;
type CreditsResult = CreditsResponse | ErrorResponse;

type UpdateFn = typeof OpenRouterKeyProvider.prototype.update;

export class OpenRouterKeyChecker extends KeyCheckerBase<OpenRouterKey> {
  constructor(keys: OpenRouterKey[], updateKey: UpdateFn) {
    super(keys, {
      service: "openrouter",
      keyCheckPeriod: KEY_CHECK_PERIOD,
      minCheckInterval: MIN_CHECK_INTERVAL,
      updateKey,
    });
  }

  protected async testKeyOrFail(key: OpenRouterKey) {
    const { status, info, remainingBalance } = await this.testKey(key);
    this.updateKey(key.hash, { status, info, remainingBalance });
    this.log.info(
      { key: key.hash, status, info, remainingBalance },
      "Checked OpenRouter key."
    );
  }

  protected handleAxiosError(key: OpenRouterKey, error: AxiosError) {
    if (error.response?.status === 429) {
      this.updateKey(key.hash, { 
        status: 'UNKNOWN (Rate Limited)', 
        info: 'Rate limit exceeded during check.' ,
        remainingBalance: null,
      });
      return;
    }
    
    this.log.error(
      { key: key.hash, error: error.message },
      "Network error while checking key; trying this key again in an hour."
    );
    const oneHour = 60 * 60 * 1000;
    const next = Date.now() - (KEY_CHECK_PERIOD - oneHour);
    this.updateKey(key.hash, { lastChecked: next, remainingBalance: null });
  }

  private async makeRequest<T extends KeyInfoResult | CreditsResult>(key: OpenRouterKey, endpoint: string, method: 'GET' | 'POST' = 'GET', data?: any): Promise<{ status: number, data: T }> {
    const headers = { 'Authorization': `Bearer ${key.key}`, 'Content-Type': 'application/json' };
    const config = { headers };
    
    try {
      let response;
      if (method === 'POST') {
        response = await axios.post<T>(`${OPENROUTER_BASE_URL}/${endpoint}`, data, config);
      } else {
        response = await axios.get<T>(`${OPENROUTER_BASE_URL}/${endpoint}`, config);
      }
      return { status: response.status, data: response.data as T };
    } catch (e: any) {
      const error = e as AxiosError<ErrorResponse>;
      // This cast assumes the error response body matches ErrorResponse structure
      return { 
        status: error.response?.status || 500, 
        data: error.response?.data as T || { error: { message: error.message } } as T
      };
    }
  }
  
  private parseCredits(creditsResult: CreditsResult): { remainingBalance: number, creditsInfoStr: string } {
    const defaultResult = { remainingBalance: -1, creditsInfoStr: "Account balance N/A" };
    
    if ('error' in creditsResult) {
        return defaultResult;
    }
    
    const credits = (creditsResult as CreditsResponse).data;
    const totalCredits = parseFloat(credits.total_credits as string || '0');
    const totalUsage = parseFloat(credits.total_usage as string || '0');
    
    if (isNaN(totalCredits) || isNaN(totalUsage)) {
        return defaultResult;
    }
    
    const remainingBalance = totalCredits - totalUsage;
    const creditsInfoStr = `Account Balance: $${remainingBalance.toFixed(4)} (Used $${totalUsage.toFixed(2)}/$${totalCredits.toFixed(2)})`;
    
    return { remainingBalance, creditsInfoStr };
  }

  
  private async testKey(key: OpenRouterKey): Promise<{ status: OpenRouterKeyStatus, info: string, remainingBalance: number | null }> {
    const { status: keyStatus, data: keyResult } = await this.makeRequest<KeyInfoResult>(key, 'key');

    if (keyStatus === 429) {
      return { status: 'UNKNOWN (Rate Limited)', info: "Could not verify due to rate limits", remainingBalance: null };
    }
    
    const keyData = (keyResult as KeyInfoResponse).data; 
    if (keyStatus !== 200 || !keyData) {
      const errorMsg = (keyResult as ErrorResponse).error?.message || 'Invalid response';
      return { status: 'DEAD', info: errorMsg, remainingBalance: null };
    }
    
    const keyInfo = keyData;

    if (keyInfo.is_free_tier) {
      const usage = keyInfo.usage || 0.0;
      // Assuming free tier is $0.01
      const remaining = Math.max(0, 0.01 - usage); 
      const status: OpenRouterKeyStatus = remaining > 0.000001 ? 'FREE (Active)' : 'FREE (Exhausted)';
      const info = `Remaining: $${remaining.toFixed(6)}`;
      return { status, info, remainingBalance: remaining };
    } else {
      // Paid key logic: Get Account Balance first
      const { status: creditsStatus, data: creditsResult } = await this.makeRequest<CreditsResult>(key, 'credits');
      const { remainingBalance, creditsInfoStr } = this.parseCredits(creditsResult);

      const limitRemaining = keyInfo.limit_remaining;
      const limitVal = keyInfo.limit;
      const limitStr = `Key Limit: $${limitVal?.toFixed(2) || 'None'}`;
      
      let finalRemainingBalance = remainingBalance > -1 ? remainingBalance : null;

      // 1. Check, if key's spending limit has been reached. This has highest priority.
      if (limitRemaining !== null && limitRemaining <= 0) {
        return { 
            status: 'PAID (Limit Reached)', 
            info: `Key's spending limit has been reached | ${limitStr} | ${creditsInfoStr}`, 
            remainingBalance: 0 
        };
      }
      
      // 2. Check Account Balance (total_credits - total_usage)
      if (remainingBalance > 0) {
          const limitRemStr = limitRemaining !== null ? `Key Limit Remaining: $${limitRemaining.toFixed(4)}` : "";
          const info = `${limitRemStr} | ${limitStr} | ${creditsInfoStr}`.trim().replace(/^ \|/, '').replace(/\| $/, '');
          return { 
              status: 'PAID (Balance)', 
              info: info, 
              remainingBalance: finalRemainingBalance 
          };
      }
      
      // 3. If Account Balance is zero or negative, key is out of credits.
      return { 
          status: 'PAID (No Credits)', 
          info: `Out of pre-paid credits | ${limitStr} | ${creditsInfoStr}`, 
          remainingBalance: finalRemainingBalance !== null ? Math.max(0, finalRemainingBalance) : 0 
      };
    }
  }
}