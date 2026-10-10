package fr.kabot83.moncarnet;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Réception des partages Android (« Partager → Mon Carnet » depuis TikTok, Instagram, Chrome…).
 *
 * Aucun partage ne peut être perdu : chaque partage reçu est d'abord écrit dans une file
 * persistante (SharedPreferences, écriture synchrone), puis l'interface web est prévenue.
 * L'interface lit la file (getPending), enregistre les publications dans sa base, puis
 * confirme (ack) : seulement alors l'élément est retiré. Si l'application est fermée, encore
 * en démarrage ou tuée entre-temps, la file est relue au lancement suivant.
 */
@CapacitorPlugin(name = "MonCarnetShare")
public class ShareReceiverPlugin extends Plugin {

    private static final String PREFS = "moncarnet_shares";
    private static final String KEY = "pending";
    private static final int MAX_TEXT = 20000;
    private static final int MAX_PENDING = 50;

    /** Extrait le contenu d'un Intent ACTION_SEND texte et l'ajoute à la file. Renvoie vrai si un partage a été retenu. */
    public static boolean enqueue(Activity activity, Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return false;
        String type = intent.getType();
        if (type != null && !type.startsWith("text/")) return false;
        String text = charSeq(intent.getCharSequenceExtra(Intent.EXTRA_TEXT));
        // Certaines applications ne transmettent le texte que dans le presse-papiers de l'Intent.
        if (text.isEmpty()) {
            ClipData clip = intent.getClipData();
            if (clip != null && clip.getItemCount() > 0) text = charSeq(clip.getItemAt(0).getText());
        }
        String subject = charSeq(intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT));
        String title = charSeq(intent.getCharSequenceExtra(Intent.EXTRA_TITLE));
        if (text.isEmpty() && subject.isEmpty() && title.isEmpty()) return false;
        String referrer = "";
        try {
            Uri ref = activity.getReferrer();
            if (ref != null) referrer = ref.toString();
        } catch (Exception ignored) {
            // Référent indisponible : sans conséquence.
        }
        try {
            JSONObject item = new JSONObject();
            item.put("id", UUID.randomUUID().toString());
            item.put("text", truncate(text));
            item.put("subject", truncate(subject));
            item.put("title", truncate(title));
            item.put("referrer", referrer);
            item.put("receivedAt", System.currentTimeMillis());
            synchronized (ShareReceiverPlugin.class) {
                JSONArray list = read(activity);
                list.put(item);
                // Garde-fou : la file ne grossit jamais indéfiniment.
                while (list.length() > MAX_PENDING) list.remove(0);
                write(activity, list);
            }
            return true;
        } catch (JSONException e) {
            return false;
        }
    }

    private static String charSeq(CharSequence c) {
        return c == null ? "" : c.toString().trim();
    }

    private static String truncate(String s) {
        return s.length() > MAX_TEXT ? s.substring(0, MAX_TEXT) : s;
    }

    private static JSONArray read(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        try {
            return new JSONArray(prefs.getString(KEY, "[]"));
        } catch (JSONException e) {
            return new JSONArray();
        }
    }

    private static void write(Context ctx, JSONArray list) {
        // commit() (synchrone) et non apply() : le partage est sur le disque avant toute autre étape.
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, list.toString()).commit();
    }

    /** Prévient l'interface web qu'un partage attend (conservé si personne n'écoute encore). */
    public void notifyShare() {
        notifyListeners("shareReceived", new JSObject(), true);
    }

    @PluginMethod
    public void getPending(PluginCall call) {
        JSArray items = new JSArray();
        synchronized (ShareReceiverPlugin.class) {
            JSONArray list = read(getContext());
            for (int i = 0; i < list.length(); i++) items.put(list.opt(i));
        }
        JSObject ret = new JSObject();
        ret.put("items", items);
        call.resolve(ret);
    }

    @PluginMethod
    public void ack(PluginCall call) {
        JSArray ids = call.getArray("ids");
        Set<String> done = new HashSet<>();
        if (ids != null) {
            for (int i = 0; i < ids.length(); i++) done.add(ids.optString(i));
        }
        synchronized (ShareReceiverPlugin.class) {
            JSONArray list = read(getContext());
            JSONArray keep = new JSONArray();
            for (int i = 0; i < list.length(); i++) {
                JSONObject o = list.optJSONObject(i);
                if (o != null && !done.contains(o.optString("id"))) keep.put(o);
            }
            write(getContext(), keep);
        }
        call.resolve();
    }

    /** Retour à l'application d'où vient le partage (TikTok, Instagram…). */
    @PluginMethod
    public void moveToBack(PluginCall call) {
        Activity a = getActivity();
        if (a != null) a.runOnUiThread(() -> a.moveTaskToBack(true));
        call.resolve();
    }

    /** Ouvre un lien hors de l'application : l'application TikTok / Instagram si elle est installée, sinon le navigateur. */
    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://")) {
            call.reject("Lien invalide");
            return;
        }
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addCategory(Intent.CATEGORY_BROWSABLE);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("Aucune application pour ouvrir ce lien");
        }
    }
}
