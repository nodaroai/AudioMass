FROM caddy:2.9-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY src/ /srv/

# AudioMass ships unhashed asset filenames (app.js, engine.js, main.css, ...).
# index.html is served uncached while those assets are cacheable, so any shared
# cache that holds them across a deploy pairs a fresh HTML entry point with
# stale modules -- which is how the 2026-07-28 upstream bump went live with new
# multitrack.js/amss-format.js loading against a cached old app.js, leaving the
# embedded editor initialised but with its interface never un-hidden.
#
# Stamp a per-build query onto every relative .js/.css reference so each deploy
# requests URLs no cache has seen. Done here rather than in the tracked HTML so
# it survives upstream syncs untouched. The Cache-Control: no-cache in the
# Caddyfile is the belt; this is the braces, and it is the part that does not
# depend on an intermediary honouring our headers.
RUN V="$(date +%s)" && \
    sed -i -E \
      -e "s#(<script[^>]+src=\")([^\":]+\.js)(\")#\1\2?v=${V}\3#g" \
      -e "s#(<link[^>]+href=\")([^\":]+\.css)(\")#\1\2?v=${V}\3#g" \
      /srv/index.html && \
    grep -q "?v=${V}" /srv/index.html || (echo "cache-bust rewrite produced no changes" && exit 1)

EXPOSE 3000
