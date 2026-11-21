// @vitest-environment jsdom
/**
 * Rel L9 + Sec L9 invite lifecycle (FriendsPanel): a double-tap mints
 * exactly one invite, and the invite clears on EVERY exit — including
 * the 90 s timeout — with the button back so a fresh invite can be
 * shown. No component-test infra exists in this repo (no
 * testing-library); this renders with React 19 `act` + `createRoot`
 * and mocks only the friends modules.
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createFriendInvite: vi.fn(),
  getFriend: vi.fn(() => undefined),
  joinFriendChannel: vi.fn(async () => {}),
  listFriends: vi.fn(() => []),
  parseFriendInvite: vi.fn(),
  runPairing: vi.fn(),
  getDisplayName: vi.fn(() => ''),
  importReceivedShares: vi.fn(async () => 0),
  listReceivedShares: vi.fn(async () => []),
  setDisplayName: vi.fn(),
  unfriendAndRekey: vi.fn(async () => {}),
}))

vi.mock('../friends/friends', () => ({
  createFriendInvite: mocks.createFriendInvite,
  getFriend: mocks.getFriend,
  joinFriendChannel: mocks.joinFriendChannel,
  listFriends: mocks.listFriends,
  parseFriendInvite: mocks.parseFriendInvite,
  runPairing: mocks.runPairing,
}))

vi.mock('../friends/service', () => ({
  getDisplayName: mocks.getDisplayName,
  importReceivedShares: mocks.importReceivedShares,
  listReceivedShares: mocks.listReceivedShares,
  setDisplayName: mocks.setDisplayName,
  unfriendAndRekey: mocks.unfriendAndRekey,
}))

import { FriendsPanel } from '../components/FriendsPanel'
import type { Identity } from '../identity/identity'

;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

const IDENTITY = { did: 'did:plc:friendtest1234567890' } as unknown as Identity
const FAKE_INVITE = {
  v: 2,
  kind: 'friend',
  room: 'friend-room-1',
  signaling: 'wss://test:4444',
  did: 'did:plc:friendtest1234567890',
  name: 'Me',
}

let container: HTMLDivElement
let root: Root
let rejectPairing: (err: Error) => void

function query(testid: string): Element | null {
  return container.querySelector(`[data-testid="${testid}"]`)
}

function click(testid: string) {
  const el = query(testid)
  expect(el).not.toBeNull()
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(async () => {
  vi.clearAllMocks()
  mocks.createFriendInvite.mockResolvedValue(FAKE_INVITE)
  rejectPairing = () => {}
  mocks.runPairing.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectPairing = reject as (err: Error) => void
      }),
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(FriendsPanel, {
        identity: IDENTITY,
        onClose: () => {},
        onOpenRecipe: () => {},
        onChanged: () => {},
      }),
    )
  })
  await flush()
})

afterEach(async () => {
  await act(async () => {
    root.unmount()
  })
  container.remove()
})

describe('FriendsPanel invite lifecycle (Rel L9 + Sec L9)', () => {
  it('a double-tap mints exactly one invite and shows it', async () => {
    // Two clicks in the same tick: the second showInvite must hit the
    // synchronous pairingRef guard and return before minting.
    const button = query('friend-show-invite')
    expect(button).not.toBeNull()
    act(() => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await flush()
    expect(mocks.createFriendInvite).toHaveBeenCalledTimes(1)
    expect(mocks.runPairing).toHaveBeenCalledTimes(1)
    // The invite is displayed and the button is hidden while pairing
    // listens, so there is no second mint path in the UI either.
    expect(query('friend-invite-qr')).not.toBeNull()
    expect(query('friend-show-invite')).toBeNull()
  })

  it('the invite clears when pairing times out, and the button comes back', async () => {
    click('friend-show-invite')
    await flush()
    expect(query('friend-invite-qr')).not.toBeNull()

    await act(async () => {
      rejectPairing(new Error('Pairing timed out — the other device never answered.'))
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    await flush()

    // Rel L9: no stale "Waiting for them…" with nobody listening.
    expect(query('friend-invite-qr')).toBeNull()
    expect(query('friend-invite-code')).toBeNull()
    expect(query('friend-show-invite')).not.toBeNull()
    expect(query('friend-error')?.textContent).toMatch(/Pairing timed out/)
    expect(mocks.joinFriendChannel).not.toHaveBeenCalled()

    // The guard is released too: a fresh click mints a new invite.
    click('friend-show-invite')
    await flush()
    expect(mocks.createFriendInvite).toHaveBeenCalledTimes(2)
    expect(query('friend-invite-qr')).not.toBeNull()
  })
})
