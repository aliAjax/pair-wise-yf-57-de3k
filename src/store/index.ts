import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';

export type SyncState = 'local' | 'queued' | 'synced' | 'conflict';
export type RiskLevel = 'low' | 'medium' | 'high';

/** 占用：打开记录即取得一段时限，时限内只有本人能提交结论 */
export interface Claim { owner: string; ownerName: string; expiresAt: number; }

export interface PatrolObservation {
  id: string;
  time: string;
  note: string;
  risk: RiskLevel;
  sync: SyncState;
  reviewed: boolean;
  reviewConclusion?: string | null;
  reviewerName?: string | null;
  claim?: Claim | null;
  reuploadedAt?: number | null;
}
export interface TrackPoint { id: string; latitude: number; longitude: number; at: string; source: 'gps' | 'manual'; }
export interface Sample {
  id: string;
  code: string;
  species: string;
  count: number;
  status: 'draft' | 'submitted' | 'verified';
  observationId?: string | null;
  /** 补传后核验退回重判，已送检的保留送检状态 */
  needsReconfirm?: boolean;
}
interface State {
  observations: PatrolObservation[];
  points: TrackPoint[];
  samples: Sample[];
  conflict: string | null;
  online: boolean;
  notice: string | null;
}

/** 占用时限：5 分钟 */
export const LEASE_MS = 5 * 60 * 1000;

const seed: State = {
  observations: [
    { id: 'o1', time: '2026-09-29 07:20', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', sync: 'synced', reviewed: false, claim: null },
    { id: 'o2', time: '2026-09-29 08:05', note: '红外相机外壳松动，已拍照待补报', risk: 'high', sync: 'queued', reviewed: false, claim: null },
    { id: 'o3', time: '2026-09-29 08:40', note: '样线南段没有异常', risk: 'low', sync: 'synced', reviewed: true, reviewConclusion: '无异常，记录在案', reviewerName: '张负责人', claim: null }
  ],
  points: [
    { id: 'p1', latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps' },
    { id: 'p2', latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps' }
  ],
  samples: [{ id: 's1', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'submitted', observationId: 'o2' }],
  conflict: null,
  online: true,
  notice: null
};

function pruneExpiredClaims(observations: PatrolObservation[]): PatrolObservation[] {
  const now = Date.now();
  return observations.map((item) => (item.claim && item.claim.expiresAt <= now ? { ...item, claim: null } : item));
}

function readState(): State {
  try {
    const saved = Taro.getStorageSync('yf57-patrol-state');
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<State>;
      return {
        ...seed,
        ...parsed,
        online: parsed.online ?? true,
        notice: null,
        observations: pruneExpiredClaims(parsed.observations ?? seed.observations),
        samples: parsed.samples ?? seed.samples
      };
    }
    return seed;
  } catch { return seed; }
}

const slice = createSlice({
  name: 'patrol', initialState: readState(),
  reducers: {
    addObservation: (state, action: PayloadAction<PatrolObservation>) => {
      state.observations.unshift(action.payload);
    },
    addPoint: (state, action: PayloadAction<{ latitude: number; longitude: number }>) => {
      state.points.push({ id: `p-${Date.now()}`, ...action.payload, at: new Date().toLocaleTimeString(), source: 'gps' });
    },
    addSample: (state, action: PayloadAction<Sample>) => {
      state.samples.unshift(action.payload);
    },
    syncQueue: (state) => {
      state.observations = state.observations.map((item) => item.sync === 'queued' ? { ...item, sync: 'conflict' } : item);
      state.conflict = '服务器上已有同一巡护记录，请选择保留本地版本或合并负责人复核意见。';
    },
    resolveConflict: (state, action: PayloadAction<'local' | 'remote'>) => {
      state.observations = state.observations.map((item) => item.sync === 'conflict' ? { ...item, sync: 'synced' } : item);
      state.conflict = null;
      Taro.setStorageSync('yf57-conflict-resolution', action.payload);
    },
    /** 领取复核：打开记录即取得一段时限；时限内只有本人能提交结论 */
    claimObservation: (state, action: PayloadAction<{ id: string; owner: string; ownerName: string }>) => {
      const item = state.observations.find((entry) => entry.id === action.payload.id);
      if (!item || item.reviewed || item.risk === 'low') return;
      if (!state.online) {
        state.notice = '当前离线，无法领取占用；恢复联网后可重新领取。';
        return;
      }
      const now = Date.now();
      if (item.claim && item.claim.expiresAt <= now) item.claim = null;
      if (item.claim && item.claim.owner !== action.payload.owner) {
        state.notice = `该记录正被 ${item.claim.ownerName} 占用（剩余 ${Math.max(0, Math.ceil((item.claim.expiresAt - now) / 1000))} 秒），请稍后再试。`;
        return;
      }
      item.claim = { owner: action.payload.owner, ownerName: action.payload.ownerName, expiresAt: now + LEASE_MS };
      state.notice = null;
    },
    /** 提交结论：仅占用本人且在时限内可提交；提交后占用释放 */
    submitReview: (state, action: PayloadAction<{ id: string; owner: string; ownerName: string; conclusion: string }>) => {
      const item = state.observations.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      const now = Date.now();
      if (!state.online) {
        item.claim = null;
        state.notice = '已断网，占用已释放回待复核池，结论未提交；恢复联网后请重新领取。';
        return;
      }
      if (!item.claim || item.claim.expiresAt <= now) {
        item.claim = null;
        state.notice = '占用已超时，记录回到待复核池；请重新领取后再提交结论。';
        return;
      }
      if (item.claim.owner !== action.payload.owner) {
        state.notice = `只有占用本人（${item.claim.ownerName}）能提交结论。`;
        return;
      }
      item.reviewed = true;
      item.reviewConclusion = action.payload.conclusion.trim() || '（无补充结论）';
      item.reviewerName = action.payload.ownerName;
      item.claim = null;
      state.notice = null;
    },
    /** 主动放弃占用，记录回到待复核池 */
    releaseClaim: (state, action: PayloadAction<{ id: string; owner: string }>) => {
      const item = state.observations.find((entry) => entry.id === action.payload.id);
      if (item?.claim?.owner === action.payload.owner) {
        item.claim = null;
        state.notice = '已放弃占用，记录回到待复核池。';
      }
    },
    /** 秒级心跳：超时占用自动释放回待复核池 */
    tick: (state) => {
      state.observations = pruneExpiredClaims(state.observations);
    },
    /** 断网即释放全部占用；恢复联网后可重新领取 */
    setOnline: (state, action: PayloadAction<boolean>) => {
      state.online = action.payload;
      if (!action.payload) {
        state.observations = state.observations.map((item) => item.claim ? { ...item, claim: null } : item);
        state.notice = '已断网：全部占用释放，记录回到待复核池；恢复联网后可重新领取。';
      } else {
        state.notice = '已恢复联网，可重新领取待复核记录。';
      }
    },
    /** 巡护员补传：观察记录一更新，旧占用和结论失效，样本核验退回重判 */
    reuploadObservation: (state, action: PayloadAction<string>) => {
      const item = state.observations.find((entry) => entry.id === action.payload);
      if (!item) return;
      item.note = `${item.note}（巡护员补传更新于 ${new Date().toLocaleTimeString()}）`;
      item.sync = 'queued';
      item.reviewed = false;
      item.reviewConclusion = null;
      item.reviewerName = null;
      item.claim = null;
      item.reuploadedAt = Date.now();
      state.samples = state.samples.map((sample) => {
        if (sample.observationId !== item.id) return sample;
        // 已送检的保留送检状态，但核验退回重判，页面标出待重新确认
        return { ...sample, status: sample.status === 'verified' ? 'submitted' : sample.status, needsReconfirm: true };
      });
      state.notice = '观察记录已补传更新：旧占用与结论失效，样本核验退回重判（已送检样本保留送检）。';
    },
    /** 样本核验 / 重新核验：重判后清除待重新确认标记 */
    verifySample: (state, action: PayloadAction<string>) => {
      const item = state.samples.find((entry) => entry.id === action.payload);
      if (item) { item.status = 'verified'; item.needsReconfirm = false; }
    },
    clearNotice: (state) => { state.notice = null; }
  }
});

export const patrolApi = createApi({ reducerPath: 'patrolApi', baseQuery: fakeBaseQuery(), endpoints: (builder) => ({ connection: builder.query<{ online: boolean }, void>({ queryFn: () => ({ data: { online: true } }) }) }) });
export const { useConnectionQuery } = patrolApi;
export const {
  addObservation, addPoint, addSample, resolveConflict,
  claimObservation, submitReview, releaseClaim, tick, setOnline, reuploadObservation,
  syncQueue, verifySample, clearNotice
} = slice.actions;
export const store = configureStore({ reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer }, middleware: (getDefault) => getDefault().concat(patrolApi.middleware) });
if (typeof window !== 'undefined') store.subscribe(() => Taro.setStorageSync('yf57-patrol-state', JSON.stringify(store.getState().patrol)));

export type RootState = ReturnType<typeof store.getState>;
