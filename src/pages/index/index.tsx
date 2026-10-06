import { Button, Input, ScrollView, Text, Textarea, View } from '@tarojs/components';
import { Cell as NutCell, Dialog as NutDialog } from '@nutui/nutui-react-taro';
import Taro from '@tarojs/taro';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useDispatch, useSelector } from 'react-redux';
import { useI18n } from '../../i18n';
import { addObservation, addPoint, claimReview, releaseReview, resolveConflict, REVIEW_LOCK_TTL, REVIEWERS, setCurrentUser, setOnline, submitConclusion, sweepLocks, syncQueue, updateObservation, verifySample, type PatrolObservation, type RootState } from '../../store';
import './index.scss';

const formSchema = z.object({ note: z.string().min(2), risk: z.enum(['low', 'medium', 'high']), species: z.string(), count: z.string() });
type FormValues = z.infer<typeof formSchema>;
const LOCK_SECONDS = REVIEW_LOCK_TTL / 1000;

export default function Index() {
  const t = useI18n();
  const dispatch = useDispatch();
  const state = useSelector((root: RootState) => root.patrol);
  const { register, handleSubmit, reset } = useForm<FormValues>({ resolver: zodResolver(formSchema), defaultValues: { note: '', risk: 'low', species: '', count: '1' } });
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => { setNow(Date.now()); dispatch(sweepLocks()); }, 1000);
    return () => clearInterval(timer);
  }, [dispatch]);
  const queued = state.observations.filter((item) => item.sync !== 'synced').length;
  const isReviewed = (item: PatrolObservation) => item.conclusion !== null && item.conclusion.version === item.version;
  const pendingReview = state.observations.filter((item) => item.risk !== 'low' && !isReviewed(item)).length;
  const otherUser = REVIEWERS.find((name) => name !== state.currentUser) ?? REVIEWERS[0];
  const recordPoint = async () => {
    try { const result = await Taro.getLocation({ type: 'gcj02' }); dispatch(addPoint({ latitude: result.latitude, longitude: result.longitude })); } catch { dispatch(addPoint({ latitude: 30.5, longitude: 103.2 })); }
  };
  const submit = (values: FormValues) => {
    dispatch(addObservation({ note: values.note, risk: values.risk, sample: values.species ? { code: `WD-${Date.now().toString().slice(-5)}`, species: values.species, count: Number(values.count) || 1 } : undefined }));
    reset();
  };
  const resubmit = (item: PatrolObservation) => dispatch(updateObservation({ id: item.id, note: `${item.note}（巡护员补传）` }));
  return <View className="page">
    <View className="hero"><Text className="eyebrow">FIELD PATROL / PORT 62022</Text><Text className="title">{t.title}</Text><Text className="sub">弱网也能记录，联网后统一同步；负责人只复核有风险的记录。</Text></View>
    <View className="metrics"><View><Text>轨迹点</Text><Text className="metric">{state.points.length}</Text></View><View><Text>待同步</Text><Text className="metric warn">{queued}</Text></View><View><Text>样本</Text><Text className="metric">{state.samples.length}</Text></View></View>
    <View className="card"><View className="card-title">现场记录</View><form onSubmit={handleSubmit(submit)}><Textarea className="textarea" placeholder="记录观察、痕迹、设备问题或现场风险" {...register('note', { required: true })} /><View className="two"><Input className="input" placeholder="物种或样本名称" {...register('species')} /><Input className="input" type="number" placeholder="数量" {...register('count')} /></View><View className="risk"><Text>风险等级</Text><select {...register('risk')}><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></View><Button className="primary" formType="submit">{t.save}</Button><Button className="secondary" onClick={recordPoint}>记录当前轨迹点</Button></form></View>
    {state.conflict && <View className="alert conflict"><Text>{state.conflict}</Text><View className="alert-actions"><Button size="mini" onClick={() => dispatch(resolveConflict('local'))}>保留本地</Button><Button size="mini" onClick={() => dispatch(resolveConflict('remote'))}>合并云端意见</Button></View></View>}
    <View className="card"><View className="card-title">{t.sync}<Text className="count">{queued} 条</Text></View><Button className="secondary" onClick={() => dispatch(syncQueue())}>模拟恢复联网并同步</Button><Button className="secondary" onClick={() => dispatch(setOnline(!state.online))}>{state.online ? '模拟断网' : '恢复网络'}</Button><Text className="hint">{state.online ? '同步遇到同一记录修改时，将进入冲突列表，不会覆盖整批数据。' : '已断网：我的复核占用已退回待复核池，恢复网络后可重新领取。'}</Text></View>
    <View className="card"><View className="card-title">{t.review}<Text className="count">{pendingReview} 条待复核</Text></View>
      <View className="review-bar"><Text>值班：{state.currentUser}</Text><Button size="mini" onClick={() => dispatch(setCurrentUser(otherUser))}>切换为{otherUser}</Button></View>
      <Text className="hint">领取后 {LOCK_SECONDS} 秒内仅本人可提交结论；断网或超时自动退回待复核池。巡护员补传后旧占用与结论失效。</Text>
      {!state.online && <Text className="hint offline">断网中，无法领取或提交复核。</Text>}
      <ScrollView scrollY className="list">{state.observations.map((item) => {
        const lock = item.lock;
        const lockActive = lock !== null && lock.until > now;
        const mine = lockActive && lock.by === state.currentUser;
        const lowRisk = item.risk === 'low';
        const reviewed = isReviewed(item);
        let lockLabel = '';
        if (!lowRisk && !reviewed) lockLabel = lockActive && lock ? `${mine ? '我已占用' : `${lock.by} 复核中`} · 剩 ${Math.max(1, Math.ceil((lock.until - now) / 1000))} 秒` : '待复核池 · 可领取';
        return <View className="observation" key={item.id}>
          <View className="obs-main">
            <Text className="obs-title">{item.risk === 'high' ? '高风险 · ' : ''}{item.note}</Text>
            <Text className="muted">{item.time} · {item.sync} · v{item.version}</Text>
            {reviewed && item.conclusion && <Text className="lock-line ok">已复核 · {item.conclusion.by}</Text>}
            {lockLabel !== '' && <Text className={`lock-line${mine ? ' ok' : ''}`}>{lockLabel}</Text>}
          </View>
          <View className="obs-actions">
            {lowRisk && <Button size="mini" disabled>免复核</Button>}
            {!lowRisk && reviewed && <Button size="mini" disabled>已复核</Button>}
            {!lowRisk && !reviewed && mine && <Button size="mini" onClick={() => dispatch(submitConclusion({ id: item.id, by: state.currentUser }))}>提交结论</Button>}
            {!lowRisk && !reviewed && mine && <Button size="mini" onClick={() => dispatch(releaseReview({ id: item.id, by: state.currentUser }))}>释放</Button>}
            {!lowRisk && !reviewed && lockActive && !mine && <Button size="mini" disabled>复核中</Button>}
            {!lowRisk && !reviewed && !lockActive && <Button size="mini" disabled={!state.online} onClick={() => dispatch(claimReview({ id: item.id, by: state.currentUser }))}>领取复核</Button>}
            <Button size="mini" onClick={() => resubmit(item)}>补传更新</Button>
          </View>
        </View>;
      })}</ScrollView>
    </View>
    <View className="card"><View className="card-title">轨迹与样本</View>{state.points.slice(-3).map((point) => <NutCell key={point.id} title={`${point.latitude.toFixed(4)}, ${point.longitude.toFixed(4)}`} description={`${point.at} · ${point.source}`} />)}{state.samples.map((sample) => <View className="sample" key={sample.id}><View><Text>{sample.code} · {sample.species} × {sample.count}{sample.needsReconfirm && <Text className="badge">待重新确认</Text>}</Text><Text className="muted">{sample.status === 'verified' ? '已核验' : sample.status === 'submitted' ? '已送检' : '草稿'}{sample.observationId ? ` · 关联 ${sample.observationId}` : ''}</Text></View><Button size="mini" disabled={sample.status === 'verified'} onClick={() => dispatch(verifySample(sample.id))}>{sample.needsReconfirm ? '重新核验' : sample.status === 'verified' ? '已核验' : '核验'}</Button></View>)}</View>
    <NutDialog title="离线说明" content="轨迹点和记录会写入本地存储，恢复网络后再合并。" visible={false} />
  </View>;
}
