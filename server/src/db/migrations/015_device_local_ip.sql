-- The `ip` column records whatever address connected to the server, which behind
-- a router/NAT is that router rather than the screen. A TV on a different subnet
-- to the server therefore showed the gateway's address in its health panel -
-- useless when you need to reach the device itself. The player now reports the
-- address it sees on its own interface alongside it.
ALTER TABLE screens ADD COLUMN local_ip text;
