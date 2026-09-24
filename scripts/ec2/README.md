# NailFlow en EC2

Instalacion del 24 de septiembre de 2026, region `us-east-1`:

- Instancia: `i-0d3ef8e0ca0b0a8f5` (`nailflow-ec2`, Amazon Linux 2023).
- Volumen EBS: `vol-0cb2b77b92aacf30c`, cifrado, 12 GiB, conservado al terminar la instancia.
- Respaldo inicial privado y versionado:
  `s3://nailflow-backups-473860152031/migration-20260924/inventario.sqlite`.
- Migracion local autorizada: 3 usuarios, 3 materiales y 7 movimientos.

El entorno anterior de Elastic Beanstalk sigue existiendo; ya no recibe despliegues
de este workflow. Retirarlo por separado cuando ya no se necesite.

El workflow `Pipeline NailFlow` prueba cada push a `main`. Si pasa, `Despliegue AWS`
publica un release con el codigo, su commit y SHA-256. No contiene bases de datos,
credenciales ni `.env`. El repositorio es publico; EC2 descarga los releases sin
guardar tokens de GitHub ni depender de las credenciales temporales del laboratorio.

`nailflow-update.timer` comprueba la ultima version al arrancar y cada dos minutos.
Instala dependencias como el usuario sin privilegios `nailflow`, verifica el hash,
detiene la aplicacion, respalda SQLite, cambia la version y verifica `/api/health`.
Si el arranque falla, intenta regresar al codigo anterior. No restaura la base
automaticamente: una migracion incompatible requiere revisar el respaldo.

## Rutas

- Codigo: `/opt/nailflow/releases/`, enlace `/opt/nailflow/current`.
- Datos persistentes: `/var/lib/nailflow/inventario.sqlite`.
- Respaldos previos al despliegue: `/var/lib/nailflow/backups/`.
- Configuracion y clave JWT: `/etc/nailflow.env` (solo root).
- Actualizador: `/usr/local/sbin/nailflow-update`.

Los respaldos locales comparten disco con la base: no sustituyen una copia externa.
Vigilar el espacio y conservar respaldos externos antes de eliminar recursos.

## Operacion

```bash
sudo systemctl status nailflow nginx nailflow-update.timer
sudo journalctl -u nailflow-update.service -n 80 --no-pager
sudo systemctl start nailflow-update.service
curl --fail http://127.0.0.1/api/health
sudo cat /var/lib/nailflow/deployed-sha
```

El exito del workflow confirma la publicacion, no que una instancia apagada ya haya
instalado el release. La salud y el commit instalado se comprueban en EC2.

## AWS Academy

Despues de Start Lab, comprobar que la instancia `nailflow-ec2` este encendida.
La aplicacion y el actualizador arrancan automaticamente. La IP publica puede
cambiar despues de detener y arrancar; consultar la nueva IP en EC2.

EBS conserva los datos al detener la instancia. El volumen se configura con
`DeleteOnTermination=false`, pero Reset Lab, la eliminacion del volumen o el
vencimiento del laboratorio pueden borrar recursos; esto no es un respaldo.

La instalacion usa HTTP en el puerto 80. Configurar dominio y HTTPS antes de usar
credenciales o datos reales en produccion.

## Instalacion inicial (Amazon Linux 2023)

Ejecutar `bootstrap.sh` como root en una instancia dedicada. Instalar `update.sh`
en `/usr/local/sbin/nailflow-update` con permisos 0755. Restaurar una copia coherente
de SQLite en la ruta de datos, propietario `nailflow:nailflow`, permisos 0600.
Despues de publicar el primer release:

```bash
sudo systemctl enable --now nailflow-update.timer
sudo systemctl start nailflow-update.service
```

No habilitar el actualizador antes de terminar la restauracion inicial.
