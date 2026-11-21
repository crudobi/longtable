import { useRef, useState } from 'react'
import type { Identity } from '../identity/identity'
import { getRepo } from '../store/repo'
import {
  backupFileName,
  collectBackup,
  createEncryptedBackup,
  restoreBackup,
  type RestoreReport,
} from '../backup/backup'
import { collectExport, exportFileName, serializeExport } from '../backup/export'
import { shareOrDownloadFile } from '../backup/fileShare'
import { friendlyError } from '../friendlyError'

interface Props {
  /**
   * The device identity, or null when it is damaged (H8): creating a
   * backup needs an identity to back up, but restoring one does not —
   * the restore replaces the damaged key. Export also works without
   * one (recipes + friends by name/DID only).
   */
  identity: Identity | null
  onClose: () => void
  /** The cookbook changed (a restore landed) — refresh the list. */
  onRestored: () => void
}

/**
 * Backup & restore panel (Wave 3 C3).
 *
 * Two separate things, kept visibly separate so nobody mistakes one for
 * the other:
 *  - Export (.json, plaintext): recipes + friends by name/DID, readable
 *    by the app's own importer. NOT a full backup — no identity key, no
 *    vault, no pair secrets.
 *  - Encrypted backup (.ltbackup): everything, under a passphrase only
 *    the user knows. Restore REPLACES this device's data (the checkbox
 *    says so) and the app reloads afterwards so the restored identity
 *    and channels take effect.
 *
 * The passphrase lives only in this component's state for the duration
 * of one operation and is cleared afterwards; it is never stored, never
 * logged, and never leaves the device except inside the encrypted file.
 */
export function BackupPanel({ identity, onClose, onRestored }: Props) {
  const [createPass, setCreatePass] = useState('')
  const [createConfirm, setCreateConfirm] = useState('')
  const [restorePass, setRestorePass] = useState('')
  const [restoreFileText, setRestoreFileText] = useState<string | null>(null)
  const [restoreFileName, setRestoreFileName] = useState('')
  const [replaceConfirmed, setReplaceConfirmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const clearSecrets = () => {
    setCreatePass('')
    setCreateConfirm('')
    setRestorePass('')
  }

  const pickRestoreFile = async (file: File | null) => {
    setResult(null)
    setError(null)
    if (!file) {
      setRestoreFileText(null)
      setRestoreFileName('')
      return
    }
    try {
      setRestoreFileText(await file.text())
      setRestoreFileName(file.name)
    } catch {
      setError("That file couldn't be read on this device.")
    }
  }

  const doExport = async () => {
    setBusy(true)
    setResult(null)
    setError(null)
    try {
      const exp = await collectExport(getRepo(), localStorage)
      const text = serializeExport(exp)
      const how = await shareOrDownloadFile(exportFileName(exp.exportedAt), text)
      setResult(
        `Exported ${exp.recipes.length} recipe${exp.recipes.length === 1 ? '' : 's'} ` +
          `and ${exp.friends.length} friend${exp.friends.length === 1 ? '' : 's'} ` +
          `(${how === 'shared' ? 'shared' : 'downloaded'}). ` +
          'This file is not a full backup — it holds no identity key, vault, or pair secrets.',
      )
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const doCreateBackup = async () => {
    if (!identity) {
      setError('There is no device identity to back up right now.')
      return
    }
    setBusy(true)
    setResult(null)
    setError(null)
    try {
      if (createPass !== createConfirm) {
        setError('The two passphrases do not match — type the same one twice.')
        return
      }
      const plain = await collectBackup(getRepo(), localStorage, identity)
      const text = await createEncryptedBackup(plain, createPass)
      const how = await shareOrDownloadFile(backupFileName(plain.exportedAt), text)
      setResult(
        `Backup ${how === 'shared' ? 'shared' : 'downloaded'}: ${plain.recipes.length} recipe` +
          `${plain.recipes.length === 1 ? '' : 's'}, ${plain.friends.length} friend` +
          `${plain.friends.length === 1 ? '' : 's'}, ${plain.shares.length} share` +
          `${plain.shares.length === 1 ? '' : 's'}. Keep the file and the passphrase ` +
          'somewhere safe — without the passphrase the backup cannot be opened.',
      )
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      clearSecrets()
      setBusy(false)
    }
  }

  const doRestore = async () => {
    if (!restoreFileText) {
      setError('Choose a backup file first.')
      return
    }
    if (!replaceConfirmed) {
      setError('Tick the replacement confirmation first — restore replaces everything on this device.')
      return
    }
    setBusy(true)
    setResult(null)
    setError(null)
    try {
      const report: RestoreReport = await restoreBackup(
        getRepo(),
        localStorage,
        restoreFileText,
        restorePass,
      )
      const dropped =
        report.droppedShares + report.droppedReceived > 0
          ? ` (${report.droppedShares} orphan share${report.droppedShares === 1 ? '' : 's'} and ` +
            `${report.droppedReceived} stale received-share entr${report.droppedReceived === 1 ? 'y' : 'ies'} ` +
            'had no recipe to attach to and were left out.)'
          : ''
      setResult(
        `Restored ${report.recipes} recipes, ${report.friends} friends, ` +
          `${report.shares} shares, and the vault from the backup made ${report.exportedAt.slice(0, 10)}.${dropped} ` +
          'Reload the app to use the restored identity.',
      )
      onRestored()
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      clearSecrets()
      setBusy(false)
    }
  }

  const reloadApp = () => {
    window.location.reload()
  }

  return (
    <div className="modal-backdrop" data-testid="backup-panel">
      <div className="modal modal-wide" role="dialog" aria-label="Backup and restore">
        <h2>Backup &amp; restore</h2>
        <p className="muted">
          Your recipes, friends, and identity live only on this device —
          there is no cloud copy. If the phone is lost, they are lost with
          it, unless you have a backup file. Make one now, keep it
          somewhere safe, and keep its passphrase somewhere separate.
        </p>

        <h3>Export recipes (.json)</h3>
        <p className="muted">
          A readable file with your recipes and your friends by name and
          DID. It opens in the app&apos;s Import panel. It is{' '}
          <strong>not</strong> a full backup: it holds no identity key, no
          key vault, and no pair secrets, so friends-only shares
          can&apos;t be restored from it alone.
        </p>
        <div className="modal-actions">
          <button className="primary" data-testid="export-recipes" disabled={busy} onClick={() => void doExport()}>
            {busy ? 'Working…' : 'Export recipes'}
          </button>
        </div>

        <h3>Encrypted backup (.ltbackup)</h3>
        <p className="muted">
          Everything: identity key, friends and pair secrets, key vault,
          shares, and all recipes. Protected by a passphrase only you
          know — it is never stored on this device, and without it the
          backup cannot be opened. There is no recovery.
          {!identity && (
            <>
              {' '}Creating a backup needs a working device identity, so
              it is unavailable until the identity is restored below.
            </>
          )}
        </p>
        <label className="field-label" htmlFor="backup-passphrase">Backup passphrase</label>
        <input
          id="backup-passphrase"
          type="password"
          autoComplete="new-password"
          data-testid="backup-passphrase"
          value={createPass}
          onChange={(e) => setCreatePass(e.target.value)}
          placeholder="At least 8 characters"
        />
        <label className="field-label" htmlFor="backup-passphrase-confirm">Repeat the passphrase</label>
        <input
          id="backup-passphrase-confirm"
          type="password"
          autoComplete="new-password"
          data-testid="backup-passphrase-confirm"
          value={createConfirm}
          onChange={(e) => setCreateConfirm(e.target.value)}
          placeholder="Same passphrase again"
        />
        <div className="modal-actions">
          <button
            className="primary"
            data-testid="create-backup"
            disabled={busy || !identity || !createPass || !createConfirm}
            onClick={() => void doCreateBackup()}
          >
            {busy ? 'Working…' : 'Create encrypted backup'}
          </button>
        </div>

        <h3>Restore from a backup</h3>
        <p className="muted">
          Restoring <strong>replaces everything on this device</strong>{' '}
          — recipes, friends, shares, and identity — with what is in the
          backup file. A wrong passphrase or a damaged file changes
          nothing: the restore refuses and your current data stays as it
          is.
        </p>
        <label className="field-label" htmlFor="restore-file">Backup file</label>
        <input
          id="restore-file"
          ref={fileInputRef}
          type="file"
          accept=".ltbackup,application/json,.json"
          data-testid="restore-file"
          onChange={(e) => void pickRestoreFile(e.target.files?.[0] ?? null)}
        />
        {restoreFileName && <p className="muted">Chosen: {restoreFileName}</p>}
        <label className="field-label" htmlFor="restore-passphrase">Backup passphrase</label>
        <input
          id="restore-passphrase"
          type="password"
          autoComplete="off"
          data-testid="restore-passphrase"
          value={restorePass}
          onChange={(e) => setRestorePass(e.target.value)}
          placeholder="The passphrase the backup was made with"
        />
        <label className="field-label">
          <input
            type="checkbox"
            data-testid="restore-replace-confirm"
            checked={replaceConfirmed}
            onChange={(e) => setReplaceConfirmed(e.target.checked)}
          />{' '}
          I understand this replaces everything on this device with the backup.
        </label>
        <div className="modal-actions">
          <button
            className="primary"
            data-testid="run-restore"
            disabled={busy || !restoreFileText || !restorePass || !replaceConfirmed}
            onClick={() => void doRestore()}
          >
            {busy ? 'Working…' : 'Restore from backup'}
          </button>
          {result && result.startsWith('Restored ') && (
            <button className="primary" data-testid="reload-after-restore" onClick={reloadApp}>
              Reload app
            </button>
          )}
          <button className="ghost" data-testid="close-backup" onClick={onClose}>
            Done
          </button>
        </div>

        {result && (
          <p className="status" data-testid="backup-result">{result}</p>
        )}
        {error && (
          <p className="status error" data-testid="backup-error">{error}</p>
        )}
      </div>
    </div>
  )
}
