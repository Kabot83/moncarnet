package fr.kabot83.moncarnet;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.media.MediaMetadataRetriever;
import android.net.Uri;
import android.os.StatFs;
import android.provider.OpenableColumns;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.HttpsURLConnection;

/**
 * Liaison avec le service Carnet Media du NAS.
 *
 * Sécurité :
 * - le jeton d'appareil est chiffré par une clé AES-256 du magasin de clés Android
 *   (AndroidKeyStore, non exportable) ; il ne quitte jamais la partie native : l'interface web
 *   ne le lit pas, elle demande au plugin d'effectuer les requêtes ;
 * - HTTPS uniquement, certificat validé par Android (aucune exception de confiance) ;
 * - chemins d'API et noms de fichiers contrôlés (aucune sortie du dossier des vidéos).
 *
 * Fichiers : dossier privé de l'application (files/carnet-videos), conservé après fermeture et
 * redémarrage, supprimé seulement avec l'application. Téléchargements en flux (aucune vidéo
 * chargée en mémoire), écrits dans un fichier .part puis renommés une fois complets.
 */
@CapacitorPlugin(name = "CarnetMedia")
public class CarnetMediaPlugin extends Plugin {

    private static final String PREFS = "carnet_media";
    private static final String KEY_ALIAS = "carnet_media_token_key";
    private static final Pattern API_PATH = Pattern.compile("^/v1/[A-Za-z0-9/_.:\\-]{0,300}$");
    private static final Pattern FILE_NAME = Pattern.compile("^[A-Za-z0-9_\\-]{1,120}\\.(mp4|jpg)$");
    private static final long MAX_IMPORT_BYTES = 1024L * 1024 * 1024; // 1 Go
    private static final long SPACE_MARGIN = 200L * 1024 * 1024;

    private final ExecutorService requests = Executors.newFixedThreadPool(2);
    private final ExecutorService transfers = Executors.newSingleThreadExecutor();

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private File videoDir() {
        File d = new File(getContext().getFilesDir(), "carnet-videos");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    // ------------------------------------------------------------------------------------------
    // Jeton chiffré (AndroidKeyStore, AES-256-GCM)
    // ------------------------------------------------------------------------------------------

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

    private void storeToken(String token) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] ct = c.doFinal(token.getBytes(StandardCharsets.UTF_8));
        String v = Base64.encodeToString(c.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(ct, Base64.NO_WRAP);
        prefs().edit().putString("token", v).commit();
    }

    private String readToken() {
        String v = prefs().getString("token", null);
        if (v == null || !v.contains(":")) return null;
        try {
            String[] parts = v.split(":", 2);
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            return new String(c.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null; // clé perdue (restauration sur un autre téléphone) : jeton à saisir de nouveau
        }
    }

    @PluginMethod
    public void configure(PluginCall call) {
        String url = call.getString("url", "").trim().replaceAll("/+$", "");
        String token = call.getString("token", null);
        if (!url.isEmpty() && !url.matches("^https://[A-Za-z0-9.\\-]+(:\\d{1,5})?$")) {
            call.reject("Adresse invalide : https://nom-du-serveur[:port] attendu.");
            return;
        }
        try {
            prefs().edit().putString("url", url).commit();
            if (token != null) {
                if (token.isEmpty()) prefs().edit().remove("token").commit();
                else if (!token.matches("^mc_[A-Za-z0-9_\\-]{20,100}$")) {
                    call.reject("Jeton invalide : il commence par « mc_ ».");
                    return;
                } else storeToken(token);
            }
            call.resolve(state());
        } catch (Exception e) {
            call.reject("Enregistrement sécurisé impossible sur cet appareil.");
        }
    }

    private JSObject state() {
        JSObject o = new JSObject();
        o.put("url", prefs().getString("url", ""));
        o.put("hasToken", readToken() != null);
        return o;
    }

    @PluginMethod
    public void getConfig(PluginCall call) {
        call.resolve(state());
    }

    // ------------------------------------------------------------------------------------------
    // Requêtes à l'API (le jeton est ajouté ici)
    // ------------------------------------------------------------------------------------------

    private HttpsURLConnection open(String path, String method) throws Exception {
        String base = prefs().getString("url", "");
        String token = readToken();
        if (base.isEmpty() || token == null) throw new IllegalStateException("not_configured");
        if (!API_PATH.matcher(path).matches()) throw new IllegalArgumentException("Chemin refusé");
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        if (!(c instanceof HttpsURLConnection)) throw new IllegalStateException("HTTPS obligatoire");
        c.setRequestMethod(method);
        c.setConnectTimeout(15000);
        c.setReadTimeout(60000);
        c.setInstanceFollowRedirects(false);
        c.setRequestProperty("Authorization", "Bearer " + token);
        c.setRequestProperty("Accept", "application/json");
        return (HttpsURLConnection) c;
    }

    @PluginMethod
    public void request(PluginCall call) {
        String path = call.getString("path", "");
        String method = call.getString("method", "GET");
        String body = call.getString("body", null);
        requests.execute(() -> {
            JSObject out = new JSObject();
            try {
                HttpsURLConnection c = open(path, method);
                if (body != null) {
                    c.setDoOutput(true);
                    c.setRequestProperty("Content-Type", "application/json");
                    try (OutputStream os = c.getOutputStream()) {
                        os.write(body.getBytes(StandardCharsets.UTF_8));
                    }
                }
                int status = c.getResponseCode();
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                out.put("status", status);
                out.put("body", in == null ? "" : readLimited(in, 1024 * 1024));
                call.resolve(out);
            } catch (IllegalStateException e) {
                call.reject("Carnet Media n’est pas configuré.", "not_configured");
            } catch (Exception e) {
                call.reject("NAS injoignable : " + e.getClass().getSimpleName(), "network");
            }
        });
    }

    private static String readLimited(InputStream in, int max) throws Exception {
        ByteArrayOutputStream bo = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) {
            if (bo.size() + n > max) throw new IllegalStateException("Réponse trop volumineuse");
            bo.write(buf, 0, n);
        }
        in.close();
        return bo.toString("UTF-8");
    }

    // ------------------------------------------------------------------------------------------
    // Téléchargement d'un fichier du NAS vers le stockage de l'application
    // ------------------------------------------------------------------------------------------

    @PluginMethod
    public void download(PluginCall call) {
        String path = call.getString("path", "");
        String name = call.getString("name", "");
        if (!FILE_NAME.matcher(name).matches()) {
            call.reject("Nom de fichier refusé");
            return;
        }
        transfers.execute(() -> {
            File dest = new File(videoDir(), name);
            File part = new File(videoDir(), name + ".part");
            try {
                HttpsURLConnection c = open(path, "GET");
                c.setRequestProperty("Accept", "*/*");
                int status = c.getResponseCode();
                if (status != 200) {
                    call.reject("Le NAS a refusé le fichier (HTTP " + status + ")", status == 401 ? "unauthorized" : "http_" + status);
                    return;
                }
                long total = c.getContentLengthLong();
                long free = new StatFs(videoDir().getAbsolutePath()).getAvailableBytes();
                if (total > 0 && total + SPACE_MARGIN > free) {
                    call.reject("Espace insuffisant sur le téléphone.", "no_space");
                    return;
                }
                MessageDigest sha = MessageDigest.getInstance("SHA-256");
                long got = 0;
                long lastNotify = 0;
                try (InputStream in = c.getInputStream(); OutputStream os = new FileOutputStream(part)) {
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        os.write(buf, 0, n);
                        sha.update(buf, 0, n);
                        got += n;
                        long now = System.currentTimeMillis();
                        if (total > 0 && now - lastNotify > 300) {
                            lastNotify = now;
                            JSObject p = new JSObject();
                            p.put("name", name);
                            p.put("progress", (double) got / total);
                            notifyListeners("downloadProgress", p);
                        }
                    }
                }
                if (total > 0 && got != total) {
                    part.delete();
                    call.reject("Transfert incomplet.", "incomplete");
                    return;
                }
                if (dest.exists()) dest.delete();
                if (!part.renameTo(dest)) throw new IllegalStateException("rename");
                JSObject out = new JSObject();
                out.put("uri", Uri.fromFile(dest).toString());
                out.put("name", name);
                out.put("bytes", got);
                out.put("sha256", hex(sha.digest()));
                call.resolve(out);
            } catch (IllegalStateException e) {
                part.delete();
                call.reject("Carnet Media n’est pas configuré.", "not_configured");
            } catch (Exception e) {
                part.delete();
                call.reject("Téléchargement interrompu : " + e.getClass().getSimpleName(), "network");
            }
        });
    }

    private static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    // ------------------------------------------------------------------------------------------
    // Import d'une vidéo de la galerie (solution de secours)
    // ------------------------------------------------------------------------------------------

    @PluginMethod
    public void pickVideo(PluginCall call) {
        if (!FILE_NAME.matcher(call.getString("name", "") + "").matches()) {
            call.reject("Nom de fichier refusé");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("video/*");
        startActivityForResult(call, intent, "pickVideoResult");
    }

    @ActivityCallback
    private void pickVideoResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != android.app.Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("Aucune vidéo choisie.", "cancelled");
            return;
        }
        Uri src = data.getData();
        String name = call.getString("name", "");
        transfers.execute(() -> {
            File dest = new File(videoDir(), name);
            File part = new File(videoDir(), name + ".part");
            try {
                long size = -1;
                String display = "";
                try (Cursor cur = getContext().getContentResolver().query(src, null, null, null, null)) {
                    if (cur != null && cur.moveToFirst()) {
                        int si = cur.getColumnIndex(OpenableColumns.SIZE);
                        int ni = cur.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                        if (si >= 0 && !cur.isNull(si)) size = cur.getLong(si);
                        if (ni >= 0) display = cur.getString(ni);
                    }
                }
                if (size > MAX_IMPORT_BYTES) {
                    call.reject("Vidéo trop volumineuse (1 Go au plus).", "too_large");
                    return;
                }
                long free = new StatFs(videoDir().getAbsolutePath()).getAvailableBytes();
                if (size > 0 && size + SPACE_MARGIN > free) {
                    call.reject("Espace insuffisant sur le téléphone.", "no_space");
                    return;
                }
                MessageDigest sha = MessageDigest.getInstance("SHA-256");
                long got = 0;
                // Copie immédiate : l'accès accordé par le sélecteur est temporaire.
                try (InputStream in = getContext().getContentResolver().openInputStream(src); OutputStream os = new FileOutputStream(part)) {
                    if (in == null) throw new IllegalStateException("source");
                    byte[] buf = new byte[64 * 1024];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        got += n;
                        if (got > MAX_IMPORT_BYTES) throw new IllegalStateException("too_large");
                        os.write(buf, 0, n);
                        sha.update(buf, 0, n);
                    }
                }
                JSObject out = describe(part);
                if (out == null) {
                    part.delete();
                    call.reject("Ce fichier n’est pas une vidéo lisible.", "invalid");
                    return;
                }
                if (dest.exists()) dest.delete();
                if (!part.renameTo(dest)) throw new IllegalStateException("rename");
                out.put("uri", Uri.fromFile(dest).toString());
                out.put("name", name);
                out.put("bytes", got);
                out.put("sha256", hex(sha.digest()));
                out.put("displayName", display);
                // Miniature : image extraite de la vidéo.
                String thumb = name.replace(".mp4", ".jpg");
                if (writeFrame(dest, new File(videoDir(), thumb))) out.put("thumbnailUri", Uri.fromFile(new File(videoDir(), thumb)).toString());
                call.resolve(out);
            } catch (Exception e) {
                part.delete();
                call.reject("Import impossible : " + e.getClass().getSimpleName(), "copy_failed");
            }
        });
    }

    /** Durée et dimensions ; null si le fichier n'a pas de piste vidéo. */
    private JSObject describe(File f) {
        MediaMetadataRetriever r = new MediaMetadataRetriever();
        try {
            r.setDataSource(f.getAbsolutePath());
            if (!"yes".equals(r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO))) return null;
            JSObject o = new JSObject();
            String d = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            String w = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH);
            String h = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT);
            String rot = r.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
            boolean swap = "90".equals(rot) || "270".equals(rot);
            o.put("duration", d == null ? null : Long.parseLong(d) / 1000.0);
            o.put("width", swap ? (h == null ? null : Integer.parseInt(h)) : (w == null ? null : Integer.parseInt(w)));
            o.put("height", swap ? (w == null ? null : Integer.parseInt(w)) : (h == null ? null : Integer.parseInt(h)));
            return o;
        } catch (Exception e) {
            return null;
        } finally {
            try {
                r.release();
            } catch (Exception ignored) {
                // sans effet
            }
        }
    }

    private boolean writeFrame(File video, File jpg) {
        MediaMetadataRetriever r = new MediaMetadataRetriever();
        try {
            r.setDataSource(video.getAbsolutePath());
            Bitmap b = r.getFrameAtTime(1_000_000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
            if (b == null) return false;
            try (OutputStream os = new FileOutputStream(jpg)) {
                b.compress(Bitmap.CompressFormat.JPEG, 82, os);
            }
            return true;
        } catch (Exception e) {
            return false;
        } finally {
            try {
                r.release();
            } catch (Exception ignored) {
                // sans effet
            }
        }
    }

    // ------------------------------------------------------------------------------------------
    // Gestion des fichiers
    // ------------------------------------------------------------------------------------------

    @PluginMethod
    public void deleteFile(PluginCall call) {
        String name = call.getString("name", "");
        if (!FILE_NAME.matcher(name).matches()) {
            call.reject("Nom de fichier refusé");
            return;
        }
        new File(videoDir(), name).delete();
        call.resolve();
    }

    @PluginMethod
    public void usage(PluginCall call) {
        long bytes = 0;
        int count = 0;
        File[] files = videoDir().listFiles();
        if (files != null) {
            for (File f : files) {
                if (f.getName().endsWith(".part")) {
                    f.delete(); // reste d'un transfert interrompu
                    continue;
                }
                bytes += f.length();
                if (f.getName().endsWith(".mp4")) count++;
            }
        }
        JSObject o = new JSObject();
        o.put("bytes", bytes);
        o.put("videos", count);
        o.put("free", new StatFs(videoDir().getAbsolutePath()).getAvailableBytes());
        call.resolve(o);
    }
}
