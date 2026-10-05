import { useState } from 'react';
import type { AuthAccount } from '../shared/auth-types';
import { safeAccountAvatarUrl } from '../shared/auth-avatar';

type AvatarAccount = Pick<AuthAccount, 'providerId' | 'kind' | 'avatarUrl' | 'displayName' | 'email' | 'providerName'>;

/** Array.from preserves a complete Unicode code point, including supplementary
 * characters. Do not turn one initial into multiple letters when uppercasing. */
export function accountInitial(account: Pick<AvatarAccount, 'displayName' | 'email' | 'providerName'>): string {
  const label = [account.displayName, account.email, account.providerName].find(value => value?.trim())?.trim().normalize('NFC') ?? '?';
  const first = Array.from(label)[0] ?? '?', upper = first.toLocaleUpperCase('zh-CN');
  return Array.from(upper).length === 1 ? upper : first;
}

/** Avatars are decorative public images. No tokens, account headers, cookies or
 * referrer data are attached; a failed URL is not retried by account-list polls. */
export function AccountAvatar({ account }: { account: AvatarAccount }) {
  const url = safeAccountAvatarUrl(account.kind, account.avatarUrl);
  const key = account.providerId + ':' + (url ?? '');
  const [image, setImage] = useState<{ key: string; loaded: boolean; failed: boolean }>({ key: '', loaded: false, failed: false });
  const current = image.key === key ? image : { key, loaded: false, failed: false };
  const showImage = !!url && !current.failed;
  const loaded = showImage && current.loaded;
  return <span className="account-avatar" data-account-avatar={account.providerId} data-avatar-state={loaded ? 'image' : 'fallback'} aria-hidden="true">
    <span className="account-avatar-initial" data-avatar-fallback>{accountInitial(account)}</span>
    {showImage && <img key={key} className="account-avatar-image" data-avatar-image src={url} alt="" width={32} height={32}
      crossOrigin="anonymous" referrerPolicy="no-referrer" loading="lazy" decoding="async"
      onLoad={() => setImage({ key, loaded: true, failed: false })} onError={() => setImage({ key, loaded: false, failed: true })} />}
  </span>;
}
