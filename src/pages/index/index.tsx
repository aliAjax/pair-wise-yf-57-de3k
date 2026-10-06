import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import { Cell as NutCell, Dialog as NutDialog } from '@nutui/nutui-react-taro';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import {
  addObservation, addPoint, addSample, claimObservation, clearNotice,
  releaseClaim, resolveConflict, reuploadObservation, setOnline, submitReview,
  syncQueue, tick, verifySample, type RootState, type Claim
} from '../../store';
import './index.scss';

const formSchema = z.object({ note: z.string().min(2), risk: z.enum(['low', 'medium', 'high']), species: z.string(), count: z.string() });
type FormValues = z.infer<typeof formSchema>;

/** 值班负责人身份：占用只对本人有效，可切换以演示并发复核 */
const REVIEWERS = [
  { id: 'r-zhang', name: '张负责人' },
  { id: 'r-li', name: '李负责人' }
];

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60).toString().padStart(2, '0');
  const ss = (total % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const [reviewer, setReviewer] = useState(REVIEWERS[0]);
  const [conclusions, setConclusions] = useState<Record<string, string>>({});
  const { register, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: { note: '', risk: 'low', species: '', count: '1' } });
  const queued = state.observations.filter((item) => item.sync !== 'synced').length;
  const poolCount = state.observations.filter((item) => !item.reviewed && !(item.claim && item.claim.expiresAt > Date.now())).length;
  const claimedCount = state.observations.filter((item) => item.claim && item.claim.expiresAt > Date.now()).length;

  useEffect(() => {
    const timer = setInterval(() => dispatch(tick()), 1000);
    return () => clearInterval(timer);
  }, [dispatch]);

  const recordPoint = async () => {
    try { const result = await Taro.getLocation({ type: 'gcj02' }); dispatch(addPoint({ latitude: result.latitude, longitude: result.longitude })); } catch { dispatch(addPoint({ latitude: 30.5, longitude: 103.2 })); }
  };
  const submit = (values: FormValues) => {
    const id = `o-${Date.now()}`;
    dispatch(addObservation({ id, time: new Date().toLocaleString(), note: values.note, risk: values.risk, sync: 'queued', reviewed: false, claim: null }));
    if (values.species) dispatch(addSample({ id: `s-${Date.now()}`, code: `WD-${Date.now().toString().slice(-5)}`, species: values.species, count: Number(values.count) || 1, status: 'draft', observationId: id }));
    reset();
  };
  const claimOf = (claim?: Claim | null) => (claim && claim.expiresAt > Date.now() ? claim : null);

  return <View className="page">
    <View className="hero"><Text className="eyebrow">FIELD PATROL / PORT 62022</Text><Text className="title">{t.title}</Text><Text className="sub">弱网也能记录，联网后统一同步；负责人只复核有风险的记录。</Text>
      <View className="reviewer-switch"><Text className="switch-label">当前值班</Text>{REVIEWERS.map((item) => <Text key={item.id} className={item.id === reviewer.id ? 'chip active' : 'chip'} onClick={() => setReviewer(item)}>{item.name}</Text>)}</View>
    </View>
    <View className="metrics"><View><Text>轨迹点</Text><Text className="metric">{state.points.length}</Text></View><View><Text>待同步</Text><Text className="metric warn">{queued}</Text></View><View><Text>样本</Text><Text className="metric">{state.samples.length}</Text></View></View>
    <View className="card"><View className="card-title">现场记录</View><form onSubmit={handleSubmit(submit)}><Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note', { required: true })} /><View className="two"><Input className="input" placeholder="物种或样本名称" {...register('species')} /><Input className="input" type="number" placeholder="数量" {...register('count')} /></View><View className="risk"><Text>风险等级</Text><select {...register('risk')}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></View><Button className="primary" formType="submit">{t.save}</Button><Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button></form></View>
    {state.conflict && <View className="alert conflict"><Text>{state.conflict}</Text><View className="alert-actions"><Button size="mini" onClick={() => dispatch(resolveConflict('local'))}>保留本地</Button><Button size="mini" onClick={() => dispatch(resolveConflict('remote'))}>合并云端意见</Button></View></View>}
    {state.notice && <View className="alert notice"><Text>{state.notice}</Text><Text className="notice-close" onClick={() => dispatch(clearNotice())}>×</Text></View>}
    {!state.online && <View className="alert offline"><Text>当前离线：占用已全部释放，记录回到待复核池；结论无法提交，恢复联网后可重新领取。</Text></View>}
    <View className="card"><View className="card-title">{t.sync}<Text className="count">{queued} 条</Text></View><Button className="secondary" onClick={() => dispatch(syncQueue())}>模拟恢复联网并同步</Button><Button className="secondary" onClick={() => dispatch(setOnline(!state.online))}>{state.online ? '模拟断网（释放占用）' : '模拟恢复联网'}</Button><Text className="hint">同步遇到同一记录修改时，将进入冲突列表，不会覆盖整批数据。</Text></View>
    <View className="card"><View className="card-title">观察记录<Text className="count">待领取 {poolCount} · 占用中 {claimedCount}</Text></View><ScrollView scrollY className="list">{state.observations.map((item) => {
      const claim = claimOf(item.claim);
      const mine = claim?.owner === reviewer.id;
      const remaining = claim ? claim.expiresAt - Date.now() : 0;
      return <View className="observation" key={item.id}>
        <View className="obs-main">
          <Text className="obs-title">{item.risk === 'high' ? '高风险 · ' : ''}{item.note}</Text>
          <Text className="muted">{item.time} · {item.sync}{item.reuploadedAt ? ' · 已补传' : ''}</Text>
          {item.reviewed
            ? <Text className="obs-status reviewed">已复核 · {item.reviewerName}：{item.reviewConclusion}</Text>
            : claim
              ? <Text className={mine ? 'obs-status mine' : 'obs-status occupied'}>{mine ? '占用中（我）' : `占用中 · ${claim.ownerName}`} · 剩余 {formatRemaining(remaining)}</Text>
              : <Text className="obs-status free">待复核 · 待领取</Text>}
          {mine && <View className="claim-box"><Input className="input" placeholder="输入复核结论，仅本人在时限内可提交" value={conclusions[item.id] ?? ''} onInput={(e) => setConclusions({ ...conclusions, [item.id]: e.detail.value })} /><View className="claim-actions"><Button size="mini" className="primary" onClick={() => { dispatch(submitReview({ id: item.id, owner: reviewer.id, ownerName: reviewer.name, conclusion: conclusions[item.id] ?? '' })); setConclusions({ ...conclusions, [item.id]: '' }); }}>提交结论</Button><Button size="mini" className="secondary" onClick={() => dispatch(releaseClaim({ id: item.id, owner: reviewer.id }))}>放弃占用</Button></View></View>}
        </View>
        <View className="obs-actions">
          <Button size="mini" disabled={item.reviewed || item.risk === 'low' || !state.online || (!!claim && !mine)} onClick={() => dispatch(claimObservation({ id: item.id, owner: reviewer.id, ownerName: reviewer.name }))}>{item.reviewed ? '已复核' : claim && !mine ? `占用中 · ${claim.ownerName}` : '领取复核'}</Button>
          <Button size="mini" className="ghost" onClick={() => dispatch(reuploadObservation(item.id))}>补传更新</Button>
        </View>
      </View>;
    })}</ScrollView></View>
    <View className="card"><View className="card-title">轨迹与样本</View>{state.points.slice(-3).map((point) => <NutCell key={point.id} title={`${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`} description={`${point.at} · ${point.source}`} />)}{state.samples.map((sample) => <View className={sample.needsReconfirm ? 'sample recheck' : 'sample'} key={sample.id}><View className="sample-main"><Text>{sample.code} · {sample.species} × {sample.count}</Text>{sample.needsReconfirm && <Text className="badge-warn">待重新确认{sample.status === 'submitted' ? ' · 已送检保留' : ''}</Text>}{sample.needsReconfirm && <Text className="muted">原核验已失效，需重新判定</Text>}</View><Button size="mini" disabled={sample.status === 'verified' && !sample.needsReconfirm} onClick={() => dispatch(verifySample(sample.id))}>{sample.needsReconfirm ? '重新核验' : sample.status === 'verified' ? '已核验' : '核验'}</Button></View>)}</View>
    <NutDialog title="离线说明" content="轨迹点和记录会写入本地存储，恢复网络后再合并。" visible={false} />
  </View>;
}
