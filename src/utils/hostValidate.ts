// IPv4 / IPv6 / 호스트네임 검증

const IPV4_RE = /^((25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)$/;

// 호스트네임 (RFC 1123) — 라벨 1~63자, 영문/숫자/하이픈, 시작/끝 영숫자
const HOSTNAME_RE = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?))*$/;

export function isIPv4(s: string): boolean {
  return IPV4_RE.test(s);
}

export function isIPv6(s: string): boolean {
  // [::1] 같은 대괄호 둘러싸기는 벗겨서 검증
  const v = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  if (v.length === 0 || v.length > 45) return false;
  // 콜론이 적어도 2개는 있어야 IPv6 (순수)
  if (!v.includes(':')) return false;
  // :: 압축 0개 또는 1개
  const dcCount = (v.match(/::/g) || []).length;
  if (dcCount > 1) return false;
  // IPv4-mapped 확인 (::ffff:1.2.3.4 등)
  const parts = v.split(':');
  // 가장 마지막 부분이 IPv4면 그 부분 검증
  const last = parts[parts.length - 1];
  let ipv4Tail = false;
  if (last && last.includes('.')) {
    if (!IPV4_RE.test(last)) return false;
    ipv4Tail = true;
  }
  // 각 그룹은 1~4 hex
  const hexRe = /^[0-9a-fA-F]{1,4}$/;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === '') continue; // :: 또는 시작/끝 ::
    if (i === parts.length - 1 && ipv4Tail) continue;
    if (!hexRe.test(p)) return false;
  }
  // 그룹 개수 검증 (압축 없으면 정확히 8, IPv4 tail이면 6 + 2)
  const nonEmpty = parts.filter(p => p !== '').length;
  const groups = ipv4Tail ? nonEmpty - 1 + 2 : nonEmpty;
  if (dcCount === 0) {
    if (groups !== 8) return false;
  } else {
    if (groups >= 8) return false;
  }
  return true;
}

export function isHostname(s: string): boolean {
  return HOSTNAME_RE.test(s);
}

/** 빈 문자열은 false. host로 유효한지(IPv4/IPv6/hostname 중 하나) */
export function isValidHost(s: string): boolean {
  const v = (s || '').trim();
  if (!v) return false;
  return isIPv4(v) || isIPv6(v) || isHostname(v);
}

/** ssh2에 넘기기 전 호스트 정규화: 양쪽 공백 제거, IPv6 주소의 [...] 대괄호 벗기기 */
export function normalizeHost(s: string): string {
  let v = (s || '').trim();
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  return v;
}
