package fr.kabot83.moncarnet;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONObject;

/**
 * Session Carnet Sync (synchronisation familiale).
 *
 * Sécurité :
 * - le mot de passe n'est jamais enregistré : il sert une seule fois à ouvrir la session ;
 * - le jeton de renouvellement (90 jours, à usage unique) est chiffré par une clé AES-256 du
 *   magasin de clés Android (AndroidKeyStore, non exportable, distincte de Carnet Media) et ne
 *   quitte jamais la partie native ; l'interface ne reçoit que le jeton d'accès (1 h), gardé en
 *   mémoire ;
 * - session révoquée ou expirée côté serveur : effacée ici aussitôt ;
 * - HTTPS uniquement, certificat validé par Android (aucune exception de confiance), aucune
 *   redirection suivie ; rien n'est écrit dans les journaux.
 * Les préférences « carnet_sync » sont exclues des sauvegardes Android (la clé ne voyage pas).
 */
@CapacitorPlugin(name = "CarnetSync")
public class CarnetSyncPlugin extends Plugin {

    private static final String PREFS = "carnet_sync";
    private static final String KEY_ALIAS = "carnet_sync_session_key";
    private static final String URL_RE = "^https://[A-Za-z0-9.\\-]+(:\\d{1,5})?$";

    private final ExecutorService requests = Executors.newSingleThreadExecutor();

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // --- Secret chiffré (AndroidKeyStore, AES-256-GCM) -------------------------------------

    private SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator kg = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        kg.init(
            new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return kg.generateKey();
    }

    private void storeRefresh(String token) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] ct = c.doFinal(token.getBytes(StandardCharsets.UTF_8));
        String v = Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
        prefs().edit().putString("refresh", v).commit();
    }

    private String readRefresh() {
        String v = prefs().getString("refresh", null);
        if (v == null || !v.contains(":")) return null;
        try {
            String[] parts = v.split(":", 2);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            return new String(c.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null; // clé indisponible (autre téléphone, données restaurées) : reconnexion nécessaire
        }
    }

    private void clearSession() {
        prefs().edit().remove("refresh").remove("user").commit();
    }

    // --- HTTPS ----------------------------------------------------------------------------

    private static final class Res {
        int status;
        JSONObject body;
    }

    private Res post(String base, String path, JSONObject body, String bearer) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        if (!(c instanceof HttpsURLConnection)) throw new IllegalStateException("https");
        c.setRequestMethod("POST");
        c.setConnectTimeout(15000);
        c.setReadTimeout(30000);
        c.setInstanceFollowRedirects(false);
        c.setRequestProperty("Accept", "application/json");
        c.setRequestProperty("Content-Type", "application/json");
        if (bearer != null) c.setRequestProperty("Authorization", "Bearer " + bearer);
        c.setDoOutput(true);
        try (OutputStream os = c.getOutputStream()) {
            os.write((body == null ? "{}" : body.toString()).getBytes(StandardCharsets.UTF_8));
        }
        Res r = new Res();
        r.status = c.getResponseCode();
        InputStream in = r.status >= 400 ? c.getErrorStream() : c.getInputStream();
        String txt = in == null ? "" : readLimited(in, 256 * 1024);
        try {
            r.body = txt.isEmpty() ? new JSONObject() : new JSONObject(txt);
        } catch (Exception e) {
            r.body = new JSONObject();
        }
        c.disconnect();
        return r;
    }

    private static String readLimited(InputStream in, int max) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            if (bo.size() + n > max) throw new IllegalStateException("too_large");
            bo.write(buf, 0, n);
        }
        in.close();
        return bo.toString("UTF-8");
    }

    /** Session ouverte : jeton de renouvellement chiffré ; seul le jeton d'accès est renvoyé. */
    private JSObject opened(String base, JSONObject t) throws Exception {
        storeRefresh(t.getString("refresh_token"));
        JSONObject user = t.getJSONObject("user");
        prefs().edit().putString("url", base).putString("user", user.toString()).commit();
        JSObject out = new JSObject();
        out.put("accessToken", t.getString("access_token"));
        out.put("expiresAt", t.getLong("expires_at"));
        out.put("user", JSObject.fromJSONObject(user));
        return out;
    }

    private static String message(Res r, String fallback) {
        String m = r.body.optString("message", "");
        return m.isEmpty() ? fallback : m;
    }

    // --- API du plugin --------------------------------------------------------------------

    @PluginMethod
    public void login(PluginCall call) {
        String base = call.getString("url", "").trim().replaceAll("/+$", "");
        String login = call.getString("login", "").trim();
        String password = call.getString("password", "");
        String device = call.getString("device", "Android");
        if (!base.matches(URL_RE)) {
            call.reject("Adresse invalide : https://nom-du-serveur[:port] attendu.", "invalid_url");
            return;
        }
        if (login.isEmpty() || password.isEmpty()) {
            call.reject("Identifiant et mot de passe obligatoires.", "invalid");
            return;
        }
        requests.execute(() -> {
            try {
                JSONObject body = new JSONObject().put("login", login).put("password", password).put("device", device);
                Res r = post(base, "/v1/auth/login", body, null);
                if (r.status == 200) call.resolve(opened(base, r.body));
                else if (r.status == 401) call.reject(message(r, "Identifiant ou mot de passe incorrect."), "bad_credentials");
                else if (r.status == 429) call.reject(message(r, "Trop de tentatives : réessayez plus tard."), "too_many_attempts");
                else call.reject(message(r, "Réponse inattendue du serveur (HTTP " + r.status + ")."), "http");
            } catch (IllegalStateException e) {
                call.reject("HTTPS obligatoire.", "invalid_url");
            } catch (Exception e) {
                call.reject("Serveur injoignable (" + e.getClass().getSimpleName() + ").", "network");
            }
        });
    }

    @PluginMethod
    public void refresh(PluginCall call) {
        String base = prefs().getString("url", "");
        String token = readRefresh();
        if (base.isEmpty() || token == null) {
            call.reject("Aucune session : connexion nécessaire.", "no_session");
            return;
        }
        requests.execute(() -> {
            try {
                Res r = post(base, "/v1/auth/refresh", new JSONObject().put("refresh_token", token), null);
                if (r.status == 200) call.resolve(opened(base, r.body));
                else if (r.status == 401 || r.status == 403) {
                    clearSession(); // révoquée, expirée ou compte désactivé : rien ne reste sur l'appareil
                    call.reject(message(r, "Session expirée : reconnectez-vous."), "session_revoked");
                } else call.reject("Réponse inattendue du serveur (HTTP " + r.status + ").", "http");
            } catch (Exception e) {
                call.reject("Serveur injoignable (" + e.getClass().getSimpleName() + ").", "network");
            }
        });
    }

    @PluginMethod
    public void getSession(PluginCall call) {
        JSObject out = new JSObject();
        out.put("url", prefs().getString("url", ""));
        String user = prefs().getString("user", null);
        boolean ok = user != null && readRefresh() != null;
        out.put("configured", ok);
        try {
            out.put("user", ok ? JSObject.fromJSONObject(new JSONObject(user)) : null);
        } catch (Exception e) {
            out.put("user", null);
        }
        call.resolve(out);
    }

    /** Déconnexion : la session est fermée sur le serveur (si joignable) et effacée ici dans tous les cas. */
    @PluginMethod
    public void logout(PluginCall call) {
        String base = prefs().getString("url", "");
        String access = call.getString("accessToken", null);
        requests.execute(() -> {
            try {
                if (!base.isEmpty() && access != null) post(base, "/v1/auth/logout", null, access);
            } catch (Exception ignored) {
                // hors ligne : la session expirera d'elle-même sur le serveur
            }
            clearSession();
            call.resolve();
        });
    }
}
