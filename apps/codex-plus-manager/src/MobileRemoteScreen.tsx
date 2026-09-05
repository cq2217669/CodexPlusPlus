import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, RefreshCw, ScanLine, Smartphone, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import "./mobile-remote.css";

type Task = { id: string; name: string; workspaceName: string };
type RemoteStatus = {
  enabled: boolean;
  connected: boolean;
  bound: boolean;
  message: string;
  qrImage: string | null;
  qrExpiresAt: string | null;
  pending: { requestId: string; phoneName: string; safetyPhrase: string; expiresAt: string } | null;
  selected: string[];
  lastSyncedAt: string | null;
  syncError: string | null;
};

export function MobileRemoteScreen() {
  const [status, setStatus] = useState<RemoteStatus | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [clock, setClock] = useState(Date.now());
  const alive = useRef(true);
  const mutating = useRef(false);

  async function refreshTasks() {
    try {
      const result = await invoke<Task[]>("mobile_remote_tasks");
      if (alive.current) setTasks(result);
    } catch {
      if (alive.current) setError("任务列表暂不可用，请稍后刷新");
    }
  }

  useEffect(() => {
    alive.current = true;
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    async function poll() {
      try {
        if (!mutating.current) {
          const result = await invoke<RemoteStatus>("mobile_remote_status");
          if (!cancelled && !mutating.current) setStatus(result);
        }
      } catch {
        if (!cancelled) setError("无法读取手机连接状态");
      }
      if (!cancelled) {
        setClock(Date.now());
        timer = setTimeout(() => void poll(), 1500);
      }
    }
    void poll();
    void refreshTasks();
    return () => { cancelled = true; alive.current = false; clearTimeout(timer); };
  }, []);

  async function action(command: string, args?: Record<string, unknown>) {
    if (mutating.current) return;
    mutating.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await invoke<RemoteStatus>(command, args);
      if (alive.current) setStatus(result);
    } catch (reason) {
      // 仅显示后端约定的中文错误，避免把原生错误对象或技术字段直接交给界面。
      if (alive.current) {
        setError(typeof reason === "string" && /^\p{Script=Han}/u.test(reason) && reason.length < 120
          ? reason : "操作未完成，请检查连接后重试");
      }
    } finally {
      mutating.current = false;
      if (alive.current) setBusy(false);
    }
  }

  const pending = status?.pending;
  const confirmationValid = pending && Date.parse(pending.expiresAt) > clock;
  const qrValid = status?.qrImage && status.qrExpiresAt && Date.parse(status.qrExpiresAt) > clock;
  const selected = new Set(status?.selected ?? []);
  const visible = tasks.filter(task => `${task.name} ${task.workspaceName}`.toLowerCase().includes(query.toLowerCase()));
  const missing = [...selected].filter(id => !tasks.some(task => task.id === id)).length;

  return (
    <div className="mobile-remote-page">
      <section className="mobile-remote-connection">
        <div className="mobile-remote-heading">
          <Smartphone aria-hidden="true" size={24} />
          <h2>轩++远程</h2>
          <span role="status">{status?.message || "正在读取连接状态"}</span>
        </div>
        <div className="mobile-remote-toolbar">
          <label className="mobile-remote-toggle">
            <input type="checkbox" checked={status?.enabled ?? false} disabled={busy || !status}
              onChange={event => void action("mobile_remote_enable", { enabled: event.target.checked })} />
            连接手机
          </label>
          <Button disabled={busy || !status} onClick={() => void action("mobile_remote_pair")}>
            <ScanLine size={16} />{status?.bound ? "绑定其他手机" : "生成绑定二维码"}
          </Button>
          <span>{status?.bound ? "已绑定" : "未绑定"}</span>
          {status?.lastSyncedAt && <span>最近同步 {new Date(status.lastSyncedAt).toLocaleTimeString("zh-CN")}</span>}
        </div>
        {(error || status?.syncError) && <p role="alert" className="mobile-remote-error">{error || status?.syncError}</p>}
        {qrValid && (
          <div className="mobile-remote-pairing">
            <img src={status.qrImage!} width={256} height={256} alt="手机绑定二维码" />
            <span>等待手机扫码</span>
            <span>{new Date(status.qrExpiresAt!).toLocaleTimeString("zh-CN")} 到期</span>
          </div>
        )}
        {status?.qrImage && !qrValid && <p role="status">二维码已过期</p>}
        {pending && (
          <section className="mobile-remote-confirmation" aria-label="本机绑定确认">
            <h3>{pending.phoneName}</h3>
            <p>核对短语</p>
            <strong>{pending.safetyPhrase}</strong>
            <div className="mobile-remote-toolbar">
              <Button disabled={busy || !confirmationValid || !status.connected}
                onClick={() => void action("mobile_remote_confirm", { requestId: pending.requestId, confirmed: true })}>
                <Check size={16} />确认绑定
              </Button>
              <Button variant="outline" disabled={busy || !confirmationValid || !status.connected}
                onClick={() => void action("mobile_remote_confirm", { requestId: pending.requestId, confirmed: false })}>
                <X size={16} />拒绝
              </Button>
              {!confirmationValid && <span>确认已过期</span>}
            </div>
          </section>
        )}
      </section>
      <section className="mobile-remote-tasks">
        <div className="mobile-remote-heading">
          <h3>官方任务</h3>
          <span>已选择 {selected.size} 项</span>
          <Button variant="ghost" size="icon" title="刷新任务" aria-label="刷新任务" disabled={busy}
            onClick={() => void refreshTasks()}><RefreshCw size={16} /></Button>
        </div>
        <Input aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={event => setQuery(event.target.value)} />
        {missing > 0 && <div className="mobile-remote-toolbar">
          <span>另有 {missing} 项不在当前列表</span>
          <Button variant="outline" disabled={busy} onClick={() => void action("mobile_remote_select", {
            selected: [...selected].filter(id => tasks.some(task => task.id === id)),
          })}>取消这些同步</Button>
        </div>}
        <div className="mobile-remote-task-list">
          {visible.map(task => (
            <label className="mobile-remote-task" key={task.id}>
              <input type="checkbox" checked={selected.has(task.id)} disabled={busy || !status}
                onChange={event => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(task.id); else next.delete(task.id);
                  void action("mobile_remote_select", { selected: [...next] });
                }} />
              <span>{task.name || "未命名任务"}</span>
              <small>{task.workspaceName}</small>
            </label>
          ))}
          {!visible.length && <p>{query ? "没有匹配的任务" : "暂无可用任务"}</p>}
        </div>
      </section>
    </div>
  );
}
