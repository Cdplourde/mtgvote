import { createClient } from '@supabase/supabase-js';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY } from '$env/static/public';

const supabaseUrl = PUBLIC_SUPABASE_URL;
const supabaseKey = PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY;

export const supabase = createClient(supabaseUrl, supabaseKey);

export const MTG_GLOBAL_CHANNEL = 'mtg-vote:global';

export const STORAGE_KEYS = {
	playerName: 'mtgvote.playerName',
	clientId: 'mtgvote.clientId'
};
