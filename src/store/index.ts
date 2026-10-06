import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react';
import Taro from '@tarojs/taro';

export type SyncState = 'local' | 'queued' | 'synced' | 'conflict';
export type Risk = 'low' | 'medium' | 'high';
export interface ReviewLock { by: string; until: number; version: number; }
export interface Conclusion { by: string; version: number; at: string; }
export interface PatrolObservation { id: string; time: string; note: string; risk: Risk; sync: SyncState; version: number; lock: ReviewLock | null; conclusion: Conclusion | null; }
export interface TrackPoint { id: string; latitude: number; longitude: number; at: string; source: 'gps' | 'manual'; }
export interface Sample { id: string; code: string; species: string; count: number; status: 'draft' | 'submitted' | 'verified'; observationId: string | null; needsReconfirm: boolean; }
interface State { observations: PatrolObservation[]; points: TrackPoint[]; samples: Sample[]; conflict: string | null; currentUser: string; online: boolean; }

export const REVIEW_LOCK_TTL = 60_000;
export const REVIEWERS = ['负责人甲', '负责人乙'];

const seed: State = {
  observations: [
    { id: 'o1', time: '2026-09-29 07:20', note: '东坡发现新鲜足迹，沿溪谷方向移动', risk: 'medium', sync: 'synced', version: 1, lock: null, conclusion: null },
    { id: 'o2', time: '2026-09-29 08:05', note: '红外相机外壳松动，已拍照待补报', risk: 'high', sync: 'queued', version: 1, lock: null, conclusion: null },
    { id: 'o3', time: '2026-09-29 08:40', note: '样线南段没有异常', risk: 'low', sync: 'synced', version: 1, lock: null, conclusion: { by: '负责人乙', version: 1, at: '2026-09-29 09:10' } }
  ],
  points: [
    { id: 'p1', latitude: 30.5821, longitude: 103.2174, at: '07:20', source: 'gps' },
    { id: 'p2', latitude: 30.5856, longitude: 103.2211, at: '08:05', source: 'gps' }
  ],
  samples: [{ id: 's1', code: 'WD-0929-01', species: '疑似豹猫毛发', count: 1, status: 'submitted', observationId: 'o1', needsReconfirm: false }],
  conflict: null,
  currentUser: REVIEWERS[0],
  online: true
};

function normalizeObservation(raw: Partial<PatrolObservation> & { reviewed?: boolean }): PatrolObservation {
  return {
    id: String(raw.id ?? `o-${Date.now()}`),
    time: String(raw.time ?? ''),
    note: String(raw.note ?? ''),
    risk: raw.risk === 'high' || raw.risk === 'medium' ? raw.risk : 'low',
    sync: raw.sync ?? 'synced',
    version: typeof raw.version === 'number' ? raw.version : 1,
    lock: null,
    conclusion: raw.conclusion && typeof raw.conclusion.version === 'number' ? raw.conclusion : raw.reviewed ? { by: '历史复核', version: 1, at: '' } : null
  };
}

function normalizeSample(raw: Partial<Sample>): Sample {
  return {
    id: String(raw.id ?? `s-${Date.now()}`),
    code: String(raw.code ?? ''),
    species: String(raw.species ?? ''),
    count: Number(raw.count) || 1,
    status: raw.status === 'verified' || raw.status === 'submitted' ? raw.status : 'draft',
    observationId: raw.observationId ?? null,
    needsReconfirm: Boolean(raw.needsReconfirm)
  };
}

function readState(): State {
  try {
    const saved = Taro.getStorageSync('yf57-patrol-state');
    if (!saved) return seed;
    const parsed = JSON.parse(saved) as Partial<State>;
    return {
      ...seed,
      ...parsed,
      online: true,
      observations: (parsed.observations ?? seed.observations).map(normalizeObservation),
      samples: (parsed.samples ?? seed.samples).map(normalizeSample),
      currentUser: parsed.currentUser ?? seed.currentUser
    };
  } catch { return seed; }
}

const slice = createSlice({
  name: 'patrol', initialState: readState(),
  reducers: {
    addObservation: (state, action: PayloadAction<{ note: string; risk: Risk; sample?: { code: string; species: string; count: number } }>) => {
      const id = `o-${Date.now()}`;
      state.observations.unshift({ id, time: new Date().toLocaleString(), note: action.payload.note, risk: action.payload.risk, sync: 'queued', version: 1, lock: null, conclusion: null });
      if (action.payload.sample) state.samples.unshift({ id: `s-${Date.now()}`, ...action.payload.sample, status: 'draft', observationId: id, needsReconfirm: false });
    },
    addPoint: (state, action: PayloadAction<{ latitude: number; longitude: number }>) => {
      state.points.push({ id: `p-${Date.now()}`, ...action.payload, at: new Date().toLocaleTimeString(), source: 'gps' });
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
    setCurrentUser: (state, action: PayloadAction<string>) => {
      state.currentUser = action.payload;
    },
    setOnline: (state, action: PayloadAction<boolean>) => {
      state.online = action.payload;
      if (!action.payload) {
        state.observations = state.observations.map((item) => item.lock && item.lock.by === state.currentUser ? { ...item, lock: null } : item);
      }
    },
    claimReview: (state, action: PayloadAction<{ id: string; by: string }>) => {
      const item = state.observations.find((entry) => entry.id === action.payload.id);
      if (!item || !state.online) return;
      const now = Date.now();
      if (item.lock && item.lock.until > now && item.lock.by !== action.payload.by) return;
      item.lock = { by: action.payload.by, until: now + REVIEW_LOCK_TTL, version: item.version };
    },
    releaseReview: (state, action: PayloadAction<{ id: string; by: string }>) => {
      const item = state.observations.find((entry) => entry.id === action.payload.id);
      if (item && item.lock && item.lock.by === action.payload.by) item.lock = null;
    },
    submitConclusion: (state, action: PayloadAction<{ id: string; by: string }>) => {
      const item = state.observations.find((entry) => entry.id === action.payload.id);
      if (!item || !item.lock || !state.online) return;
      if (item.lock.by !== action.payload.by || item.lock.until <= Date.now()) return;
      if (item.lock.version !== item.version) return;
      item.conclusion = { by: action.payload.by, version: item.version, at: new Date().toLocaleString() };
      item.lock = null;
    },
    sweepLocks: (state) => {
      const now = Date.now();
      state.observations.forEach((item) => { if (item.lock && item.lock.until <= now) item.lock = null; });
    },
    updateObservation: (state, action: PayloadAction<{ id: string; note?: string; risk?: Risk }>) => {
      const item = state.observations.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      if (action.payload.note) item.note = action.payload.note;
      if (action.payload.risk) item.risk = action.payload.risk;
      item.version += 1;
      item.lock = null;
      item.conclusion = null;
      if (item.sync === 'synced') item.sync = 'queued';
      state.samples = state.samples.map((sample) => {
        if (sample.observationId !== item.id) return sample;
        if (sample.status === 'verified') return { ...sample, status: 'submitted', needsReconfirm: true };
        if (sample.status === 'submitted') return { ...sample, needsReconfirm: true };
        return sample;
      });
    },
    verifySample: (state, action: PayloadAction<string>) => {
      const item = state.samples.find((entry) => entry.id === action.payload);
      if (item) { item.status = 'verified'; item.needsReconfirm = false; }
    }
  }
});

export const patrolApi = createApi({ reducerPath: 'patrolApi', baseQuery: fakeBaseQuery(), endpoints: (builder) => ({ connection: builder.query<{ online: boolean }, void>({ queryFn: () => ({ data: { online: true } }) }) }) });
export const { useConnectionQuery } = patrolApi;
export const { addObservation, addPoint, claimReview, releaseReview, resolveConflict, setCurrentUser, setOnline, submitConclusion, sweepLocks, syncQueue, updateObservation, verifySample } = slice.actions;
export const store = configureStore({ reducer: { patrol: slice.reducer, [patrolApi.reducerPath]: patrolApi.reducer }, middleware: (getDefault) => getDefault().concat(patrolApi.middleware) });
if (typeof window !== 'undefined') store.subscribe(() => Taro.setStorageSync('yf57-patrol-state', JSON.stringify(store.getState().patrol)));

export type RootState = ReturnType<typeof store.getState>;
