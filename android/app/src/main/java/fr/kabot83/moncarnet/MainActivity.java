package fr.kabot83.moncarnet;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Affichage bord à bord : l'interface gère elle-même les zones système
        // (variables CSS injectées par Capacitor, réglage SystemBars "css").
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);
    }
}
