package fr.kabot83.moncarnet;

import android.content.Intent;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import androidx.activity.EdgeToEdge;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.PluginHandle;
import java.util.Locale;

/**
 * Activité principale.
 *
 * Gestion des zones système et du clavier — UNE seule fois, ici :
 * la fenêtre est bord à bord, et la vue racine reçoit un rembourrage égal à la
 * barre d'état (haut) et à la barre de navigation OU au clavier (bas). La
 * WebView occupe exactement l'espace restant. Les encarts sont ensuite
 * « consommés » : la WebView ne les applique pas une seconde fois (c'était
 * la cause de la zone noire au-dessus du clavier).
 *
 * L'interface web est prévenue de l'ouverture du clavier (événement
 * « mc-keyboard ») pour masquer la navigation inférieure pendant la saisie.
 *
 * Partages reçus (« Partager → Mon Carnet ») : voir ShareReceiverPlugin. L'Intent est mis
 * en file AVANT toute autre étape, que l'application soit fermée (onCreate) ou déjà
 * ouverte (onNewIntent, activité « singleTask »).
 */
public class MainActivity extends BridgeActivity {

    private Boolean lastKeyboardOpen = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(MonCarnetUiPlugin.class);
        registerPlugin(ShareReceiverPlugin.class);
        // Partage reçu à froid : mis en file avant même le démarrage de l'interface.
        // Activité recréée (savedInstanceState) : le partage est déjà en file, l'Intent est
        // seulement neutralisé (Capacitor rappelle onNewIntent avec l'Intent de lancement).
        if (savedInstanceState == null) consumeShareIntent(getIntent());
        else neutralize(getIntent());
        super.onCreate(savedInstanceState);
        // APRÈS super.onCreate : Capacitor a appliqué le thème final (sans barre de titre)
        // et créé la vue. Appelé avant, EdgeToEdge construisait la fenêtre avec le thème
        // de lancement, qui affichait une barre de titre native « Mon Carnet ».
        EdgeToEdge.enable(this);

        View root = getWindow().getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            boolean keyboardOpen = insets.isVisible(WindowInsetsCompat.Type.ime()) && ime.bottom > bars.bottom;
            v.setPadding(bars.left, bars.top, bars.right, keyboardOpen ? ime.bottom : bars.bottom);
            notifyKeyboard(keyboardOpen);
            return WindowInsetsCompat.CONSUMED;
        });
        ViewCompat.requestApplyInsets(root);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        // Application déjà ouverte : nouveau partage.
        if (consumeShareIntent(intent)) notifyShare();
    }

    /** Met le partage en file, puis neutralise l'Intent pour qu'il ne soit jamais traité deux fois. */
    private boolean consumeShareIntent(Intent intent) {
        if (!ShareReceiverPlugin.enqueue(this, intent)) return false;
        neutralize(intent);
        return true;
    }

    private void neutralize(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        Intent handled = new Intent(intent);
        handled.setAction(Intent.ACTION_MAIN);
        handled.removeExtra(Intent.EXTRA_TEXT);
        setIntent(handled);
    }

    private void notifyShare() {
        if (getBridge() == null) return;
        PluginHandle handle = getBridge().getPlugin("MonCarnetShare");
        if (handle != null && handle.getInstance() instanceof ShareReceiverPlugin) {
            ((ShareReceiverPlugin) handle.getInstance()).notifyShare();
        }
    }

    @Override
    public void onResume() {
        super.onResume();
        // Au retour dans l'app, l'état du clavier est réévalué.
        lastKeyboardOpen = null;
        ViewCompat.requestApplyInsets(getWindow().getDecorView());
    }

    private void notifyKeyboard(boolean open) {
        if (lastKeyboardOpen != null && lastKeyboardOpen == open) return;
        lastKeyboardOpen = open;
        if (getBridge() == null) return;
        WebView webView = getBridge().getWebView();
        if (webView == null) return;
        String js = String.format(
            Locale.US,
            "window.__mcKeyboardOpen=%b;window.dispatchEvent(new CustomEvent('mc-keyboard',{detail:{open:%b}}));",
            open,
            open
        );
        webView.post(() -> webView.evaluateJavascript(js, null));
    }
}
