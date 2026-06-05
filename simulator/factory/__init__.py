"""Simulateur d'usine Strata — architecture cerveau / faces.

Le *cerveau* (brain.py) simule l'état physique de l'usine sans connaître aucun
protocole : il expose un simple dictionnaire {tag_métier: valeur}. Les *faces*
(faces/) lisent cet état et le présentent dans un protocole (MQTT en P5 ;
Modbus/S7/EtherNet-IP en P6). Ajouter un protocole = ajouter une face, sans
toucher au cerveau.
"""
