const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const MAIL_API = 'https://outlook.office.com/api/v2.0/me/messages';

export async function refreshOutlookToken(clientId: string, refreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error(data.error_description || data.error || 'Token refresh failed');
  return { accessToken: data.access_token, refreshToken: data.refresh_token || refreshToken };
}

export async function readOutlookInbox(accessToken: string, top = 20): Promise<any[]> {
  const resp = await fetch(`${MAIL_API}?$top=${top}&$select=Subject,From,ReceivedDateTime,IsRead&$orderby=ReceivedDateTime%20desc`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`Outlook API ${resp.status}`);
  const data = await resp.json();
  return (data.value || []).map((m: any) => ({
    id: m.Id,
    subject: m.Subject,
    from: m.From?.EmailAddress?.Address,
    date: m.ReceivedDateTime,
    read: m.IsRead,
  }));
}

export async function readOutlookMailBody(accessToken: string, mailId: string): Promise<string> {
  const resp = await fetch(`https://outlook.office.com/api/v2.0/me/messages/${mailId}?$select=Body`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) throw new Error(`Outlook API ${resp.status}`);
  const data = await resp.json();
  return data.Body?.Content || '';
}
