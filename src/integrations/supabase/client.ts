import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://czoppjnkjxmduldxlbqh.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN6b3Bwam5ranhtZHVsZHhsYnFoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQzODExNzksImV4cCI6MjA4OTk1NzE3OX0.ehTRhOHFn6JAX3lKeEK0Tff8km9Q-8c0tZyIIf0qdR0";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
