import { describe, expect, it } from 'vitest';
import { normalizeLocalUrl } from './localUrl';

describe('normalizeLocalUrl', () => {
  it('accepts bare localhost with a port and adds http', () => {
    expect(normalizeLocalUrl('localhost:5173')).toBe('http://localhost:5173/');
  });

  it('accepts full URLs and keeps the path', () => {
    expect(normalizeLocalUrl('http://localhost:3000/app?x=1')).toBe(
      'http://localhost:3000/app?x=1',
    );
    expect(normalizeLocalUrl('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
    expect(normalizeLocalUrl('http://[::1]:3000')).toBe('http://[::1]:3000/');
  });

  it('accepts https on localhost', () => {
    expect(normalizeLocalUrl('https://localhost:8443')).toBe('https://localhost:8443/');
  });

  it('rejects remote hosts, other schemes and garbage', () => {
    expect(normalizeLocalUrl('https://example.com')).toBeNull();
    expect(normalizeLocalUrl('http://169.254.169.254/latest/meta-data')).toBeNull();
    expect(normalizeLocalUrl('file:///etc/passwd')).toBeNull();
    expect(normalizeLocalUrl('ftp://localhost:21')).toBeNull();
    expect(normalizeLocalUrl('not a url')).toBeNull();
    expect(normalizeLocalUrl('')).toBeNull();
  });

  it('rejects hosts that merely look local', () => {
    expect(normalizeLocalUrl('http://localhost.evil.com')).toBeNull();
    expect(normalizeLocalUrl('http://127.0.0.1.evil.com')).toBeNull();
  });
});
