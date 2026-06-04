import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
});

export async function fetchCampaign(clientKey) {
  const { data } = await api.get(`/campaigns/${clientKey}`);
  return data;
}

export async function fetchSettings(clientKey) {
  const { data } = await api.get(`/settings/${clientKey}`);
  return data;
}

export async function updateSettings(clientKey, updates) {
  const { data } = await api.put(`/settings/${clientKey}`, updates);
  return data;
}

export async function recomputeAttribution(clientKey) {
  const { data } = await api.post(`/campaigns/${clientKey}/recompute-attribution`);
  return data;
}

export async function fetchChat(clientKey, phone) {
  const { data } = await api.get(`/chats/${clientKey}/${phone}`);
  return data;
}
