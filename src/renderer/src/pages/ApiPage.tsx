import { useState } from 'react'
import type { ReactElement } from 'react'
import { AlertTriangle, LockKeyhole } from 'lucide-react'
import type { ApiProfile } from '../../../shared/types'
import { useQuantStore } from '../store'

export function ApiPage(): ReactElement {
  const apiProfiles = useQuantStore((state) => state.apiProfiles)
  const upsertApiProfile = useQuantStore((state) => state.upsertApiProfile)
  const removeApiProfile = useQuantStore((state) => state.removeApiProfile)
  const [form, setForm] = useState({
    label: 'Binance 主账户',
    apiKey: '',
    apiSecret: '',
    canTrade: false,
    environment: 'live' as 'live' | 'testnet',
  })
  const [testing, setTesting] = useState<string | null>(null)

  async function addProfile(): Promise<void> {
    if (!form.apiKey || !form.apiSecret) {
      window.alert('请输入 API Key 和 API Secret。')
      return
    }
    const profile = await window.quantApi.addApiProfile(form)
    upsertApiProfile(profile)
    setForm({ label: 'Binance 主账户', apiKey: '', apiSecret: '', canTrade: false, environment: 'live' })
  }

  async function testProfile(profile: ApiProfile): Promise<void> {
    setTesting(profile.id)
    try {
      const updated = await window.quantApi.testApiProfile(profile.id)
      upsertApiProfile(updated)
    } finally {
      setTesting(null)
    }
  }

  async function deleteProfile(profile: ApiProfile): Promise<void> {
    const confirmed = window.confirm(`删除 API「${profile.label}」？Secret 将从本地加密存储中移除。`)
    if (!confirmed) return
    await window.quantApi.removeApiProfile(profile.id)
    removeApiProfile(profile.id)
  }

  return (
    <div className="content two-column-page api-management-page">
      <section className="panel form-panel">
        <div className="panel-head">
          <div>
            <h2>API 连接管理</h2>
            <p>Secret 仅在 Electron 主进程加密保存，前端不会展示明文</p>
          </div>
          <LockKeyhole size={20} />
        </div>
        <div className="form-grid">
          <label>
            名称
            <input value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} />
          </label>
          <label>
            环境
            <select value={form.environment} onChange={(event) => setForm({ ...form, environment: event.target.value as 'live' | 'testnet' })}>
              <option value="live">实盘</option>
              <option value="testnet">测试网</option>
            </select>
          </label>
          <label>
            API Key
            <input value={form.apiKey} onChange={(event) => setForm({ ...form, apiKey: event.target.value })} />
          </label>
          <label className="wide-field">
            API Secret
            <input
              type="password"
              value={form.apiSecret}
              onChange={(event) => setForm({ ...form, apiSecret: event.target.value })}
            />
          </label>
          <label className="check-field">
            <input
              type="checkbox"
              checked={form.canTrade}
              onChange={(event) => setForm({ ...form, canTrade: event.target.checked })}
            />
            开启交易权限检测
          </label>
        </div>
        <div className="security-note">
          <AlertTriangle size={16} />
          请关闭提现权限。实盘 Key 只能选择“实盘”，测试网 Key 只能选择“测试网”，否则 Binance 会返回签名或权限异常。
        </div>
        <button className="primary-button" onClick={addProfile}>
          添加 API
        </button>
      </section>
      <section className="panel table-panel">
        <div className="panel-head">
          <div>
            <h2>API 列表</h2>
            <p>连接状态、权限检测、限频和失效提醒</p>
          </div>
        </div>
        <div className="api-help">
          如果提示“TLS / socket / 无法连接”，代表请求未到达 Binance，请先检查代理、DNS、防火墙或地区网络限制；如果提示签名/权限错误，再检查 Key 环境、IP 白名单和合约权限。
        </div>
        <div className="data-table api-profile-table">
          <div className="table-row head">
            <span>名称</span>
            <span>环境</span>
            <span>Key 尾号</span>
            <span>权限</span>
            <span>状态</span>
            <span>延迟</span>
            <span>操作</span>
          </div>
          {apiProfiles.length === 0 ? (
            <div className="empty-row">暂无 API。添加后可进行 Binance USDⓈ-M Futures 连接测试。</div>
          ) : (
            apiProfiles.map((profile) => (
              <div className="table-row" key={profile.id}>
                <span title={profile.label}>{profile.label}</span>
                <span>{profile.environment === 'testnet' ? '测试网' : '实盘'}</span>
                <span>{profile.apiKeyTail}</span>
                <span>{profile.canRead ? '读取' : '待检测'} / {profile.canTrade ? '交易' : '未启用'}</span>
                <span className={profile.status === 'connected' ? 'up' : profile.status === 'error' ? 'down' : 'muted'}>
                  {profile.status === 'connected' ? '连接正常' : profile.status === 'error' ? '异常' : '未连接'}
                  {profile.lastError && <em title={profile.lastError}>{profile.lastError}</em>}
                </span>
                <span>{profile.latencyMs}ms</span>
                <span className="table-actions">
                  <button onClick={() => testProfile(profile)} disabled={testing === profile.id}>
                    {testing === profile.id ? '测试中' : '测试'}
                  </button>
                  <button onClick={() => deleteProfile(profile)}>删除</button>
                </span>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  )
}
