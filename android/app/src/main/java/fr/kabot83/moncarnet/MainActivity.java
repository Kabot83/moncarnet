package fr.kabot83.moncarnet;

import android.os.Bundle;
import android.view.View;
import android.webkit.WebView;
import androidx.activity.EdgeToEdge;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
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
 */
public class MainActivity extends BridgeActivity {

    private Boolean lastKeyboardOpen = null;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(MonCarnetUiPlugin.class);
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);

        View root = getWindow().getDecorView();
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
            boolean keyboardOpen = insets.isVisible(WindowInsetsCompat.Type.ime()) && ime.bottom > bars.bottom;
            v.setPadding(bars.left, bars.top, bars.right, keyboardOpen ? ime.bottom : bars.bottom);
            notifyKeyboard(keyboardOpen);
            return WindowInsetsCompat.CONSUMED;
        });
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
