import type {
  AccountAsset,
  AccountPosition,
  AppPreferences,
  ApiProfile,
  LogEntry,
  OrderRecord,
  RiskEvent,
  RiskRuleSet,
  StrategyPosition,
  StrategyConfig,
} from './types'

export const APP_STATE_PATCH_CHANNEL = 'app:state-patch' as const

export interface AppStatePatch {
  preferences?: AppPreferences
  strategies?: StrategyConfig[]
  riskRules?: RiskRuleSet
  riskEvents?: RiskEvent[]
  assets?: AccountAsset[]
  positions?: AccountPosition[]
  strategyPositions?: StrategyPosition[]
  orders?: OrderRecord[]
  logs?: LogEntry[]
  apiProfiles?: ApiProfile[]
}
