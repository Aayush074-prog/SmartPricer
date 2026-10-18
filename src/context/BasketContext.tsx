import React, { createContext, useContext, useState, ReactNode } from 'react';
import { PlatformFeeConfig } from '../types/basket';
import { DEFAULT_PLATFORM_FEES, SURGE_MULTIPLIER } from '../config/platformFees';

type Platform = 'zepto' | 'blinkit';
type FeeConfigMap = Record<Platform, PlatformFeeConfig>;

interface BasketContextValue {
  feeConfig: FeeConfigMap;
  surgeActive: Record<Platform, boolean>;
  setSurge: (platform: Platform, active: boolean) => void;
  setFee: (platform: Platform, patch: Partial<PlatformFeeConfig>) => void;
}

const BasketContext = createContext<BasketContextValue | null>(null);

export function BasketProvider({ children }: { children: ReactNode }) {
  const [feeConfig, setFeeConfig] = useState<FeeConfigMap>(DEFAULT_PLATFORM_FEES);
  const [surgeActive, setSurgeActive] = useState<Record<Platform, boolean>>({
    zepto: false,
    blinkit: false,
  });

  function setSurge(platform: Platform, active: boolean) {
    setSurgeActive(prev => ({ ...prev, [platform]: active }));
    setFeeConfig(prev => ({
      ...prev,
      [platform]: {
        ...prev[platform],
        surge_multiplier: active ? SURGE_MULTIPLIER : 1.0,
      },
    }));
  }

  function setFee(platform: Platform, patch: Partial<PlatformFeeConfig>) {
    setFeeConfig(prev => ({
      ...prev,
      [platform]: { ...prev[platform], ...patch },
    }));
  }

  return (
    <BasketContext.Provider value={{ feeConfig, surgeActive, setSurge, setFee }}>
      {children}
    </BasketContext.Provider>
  );
}

export function useBasket(): BasketContextValue {
  const ctx = useContext(BasketContext);
  if (!ctx) throw new Error('useBasket must be used inside <BasketProvider>');
  return ctx;
}
